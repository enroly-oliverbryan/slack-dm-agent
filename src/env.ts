export function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name} in .env`);
  return value;
}

// the person this agent works for, as teammates know them, e.g. "Sam".
export const USER_NAME = required("USER_NAME");

// the user's pronouns, e.g. "she/her", "he/him", "they/them". Defaults to they/them when unset.
export const PRONOUNS = process.env.PRONOUNS?.trim() || "they/them";

// the one rule every prompt uses for how to refer to the user.
export const REFER_TO_USER = `Refer to ${USER_NAME} by name, or with ${PRONOUNS} pronouns.`;
