export function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name} in .env`);
  return value;
}

// the person this agent works for, as teammates know them, e.g. "Sam".
export const USER_NAME = required("USER_NAME");
