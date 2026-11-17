// Exact values Orca itself handed to a process (stored agent API keys) whose shape no pattern knows.
// Shared so every sanitizer in the process (observability sink, crash reports) strips the same set.
const MIN_REGISTERED_SECRET_LENGTH = 8
const MAX_REGISTERED_SECRETS = 256
const registeredSecretValues = new Set<string>()

export function registerRedactedSecretValue(value: string): void {
  if (
    typeof value !== 'string' ||
    value.length < MIN_REGISTERED_SECRET_LENGTH ||
    registeredSecretValues.has(value)
  ) {
    return
  }
  if (registeredSecretValues.size >= MAX_REGISTERED_SECRETS) {
    registeredSecretValues.delete(registeredSecretValues.values().next().value!)
  }
  registeredSecretValues.add(value)
}

export function redactRegisteredSecretValues(input: string, replacement: string): string {
  let out = input
  for (const value of registeredSecretValues) {
    if (out.includes(value)) {
      out = out.split(value).join(replacement)
    }
  }
  return out
}
