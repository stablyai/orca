/** Shared validation for pasted API keys: trim ends, reject empty/inner-whitespace/over-long values. */
export function validateApiKey(key: unknown, options: { name: string; maxLength: number }): string {
  if (typeof key !== 'string') {
    throw new Error(`${options.name} must be a string`)
  }
  const value = key.trim()
  if (!value) {
    throw new Error(`${options.name} is required`)
  }
  if (value.length > options.maxLength) {
    throw new Error(`That is too long to be ${options.name}`)
  }
  // Keys have no inner whitespace; a provider would echo such a value back in its header error.
  if (/[\s\p{Cc}]/u.test(value)) {
    throw new Error(`That is not ${options.name}: it has spaces or line breaks inside`)
  }
  return value
}
