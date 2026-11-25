export const LINEAR_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isLinearUuid(value: string): boolean {
  return LINEAR_UUID_PATTERN.test(value)
}
