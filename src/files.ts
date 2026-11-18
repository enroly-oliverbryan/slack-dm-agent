// files attached to DMs: screenshots, logs, snippets. Downloaded with the user token (needs files:read) and turned
// into content the models can read: images as image blocks, text files inline, anything else named only.

import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

export type SlackFile = {
  id: string;
  name?: string;
  title?: string;
  mimetype?: string;
  size?: number;
  url_private_download?: string;
  url_private?: string;
};

type ContentBlock = Exclude<SDKUserMessage["message"]["content"], string>[number];

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_TEXT_BYTES = 100 * 1024;

export type Attachments = {
  images: { name: string; mediaType: string; data: string }[]; // base64
  texts: { name: string; text: string }[];
  // attached but not readable here: too big, unsupported type, or the download failed. Named so the model knows.
  skipped: { name: string; why: string }[];
};

export const fileName = (file: SlackFile) => file.name || file.title || file.id;

const isText = (file: SlackFile) =>
  !!file.mimetype &&
  (file.mimetype.startsWith("text/") || /^application\/(json|xml|x-yaml|yaml|javascript|x-sh)$/.test(file.mimetype));

async function download(file: SlackFile, token: string): Promise<Buffer> {
  const url = file.url_private_download ?? file.url_private;
  if (!url) throw new Error("no download URL");
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  // without files:read Slack answers with its HTML login page, not the file.
  if (response.headers.get("content-type")?.startsWith("text/html") && !file.mimetype?.startsWith("text/html"))
    throw new Error("Slack returned a login page (files:read scope missing?)");
  return Buffer.from(await response.arrayBuffer());
}

export async function readAttachments(files: SlackFile[], token: string): Promise<Attachments> {
  const out: Attachments = { images: [], texts: [], skipped: [] };
  for (const file of files) {
    const name = fileName(file);
    const image = !!file.mimetype && IMAGE_TYPES.has(file.mimetype);
    if (image && out.images.length >= MAX_IMAGES) {
      out.skipped.push({ name, why: `more than ${MAX_IMAGES} images` });
      continue;
    }
    if (image && (file.size ?? 0) > MAX_IMAGE_BYTES) {
      out.skipped.push({ name, why: "image over 5 MB" });
      continue;
    }
    if (!image && !isText(file)) {
      out.skipped.push({ name, why: `${file.mimetype ?? "unknown type"} can't be read` });
      continue;
    }
    try {
      const bytes = await download(file, token);
      if (image) out.images.push({ name, mediaType: file.mimetype!, data: bytes.toString("base64") });
      else {
        const text = bytes.subarray(0, MAX_TEXT_BYTES).toString("utf8");
        out.texts.push({ name, text: bytes.length > MAX_TEXT_BYTES ? `${text}\n[truncated]` : text });
      }
    } catch (error) {
      out.skipped.push({ name, why: `download failed: ${(error as Error).message}` });
    }
  }
  return out;
}

export const hasAttachments = (a: Attachments | undefined) =>
  !!a && a.images.length + a.texts.length + a.skipped.length > 0;

// content blocks to follow a text prompt. Text and skipped files are described in the prompt text itself.
export const imageBlocks = (a: Attachments | undefined): ContentBlock[] =>
  (a?.images ?? []).map((image) => ({
    type: "image",
    source: { type: "base64", media_type: image.mediaType as "image/png", data: image.data },
  }));

// the attachments as prompt text: text files inline, images and skipped files listed by name.
export function describeAttachments(a: Attachments | undefined): string {
  if (!hasAttachments(a)) return "";
  const escape = (text: string) => text.replace(/</g, "&lt;");
  const parts = [
    ...a!.images.map((image) => `<image name="${escape(image.name)}">(attached below)</image>`),
    ...a!.texts.map((file) => `<file name="${escape(file.name)}">\n${escape(file.text)}\n</file>`),
    ...a!.skipped.map((file) => `<unreadable name="${escape(file.name)}">${escape(file.why)}</unreadable>`),
  ];
  return `<attachments>\n${parts.join("\n")}\n</attachments>`;
}

// an async-iterable prompt for the Agent SDK: the text plus any images.
export async function* promptWithImages(text: string, attachments: Attachments | undefined) {
  const message: SDKUserMessage = {
    type: "user",
    message: { role: "user", content: [{ type: "text", text }, ...imageBlocks(attachments)] },
    parent_tool_use_id: null,
  };
  yield message;
}
