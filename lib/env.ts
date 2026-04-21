export function readEnv(name: string): string {
  return String(process.env[name] || "").trim();
}

export function readOptionalEnv(name: string): string | undefined {
  const value = readEnv(name);
  return value ? value : undefined;
}

export function normalizeSingleLineSecret(raw: string): string {
  let value = String(raw || "").trim();

  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1).trim();
  }

  // Handle escaped trailing newlines like "\\r\\n" from CLI-imported env.
  value = value.replace(/(?:\\r\\n|\\n|\\r)+$/g, "");
  // Handle actual newline characters.
  value = value.replace(/[\r\n]+$/g, "");

  return value.trim();
}

export function readSecretEnv(name: string): string {
  return normalizeSingleLineSecret(process.env[name] || "");
}

export function readOptionalSecretEnv(name: string): string | undefined {
  const value = readSecretEnv(name);
  return value ? value : undefined;
}

export function readOptionalClerkPublishableKey(): string | undefined {
  const value = readOptionalSecretEnv("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY");
  if (!value) return undefined;
  // Clerk publishable key: pk_test_xxx or pk_live_xxx
  if (!/^pk_(test|live)_[A-Za-z0-9._-]+$/.test(value)) {
    return undefined;
  }
  return value;
}

export function readOptionalClerkSecretKey(): string | undefined {
  const value = readOptionalSecretEnv("CLERK_SECRET_KEY");
  if (!value) return undefined;
  if (!/^sk_(test|live)_[A-Za-z0-9._-]+$/.test(value)) {
    return undefined;
  }
  return value;
}
