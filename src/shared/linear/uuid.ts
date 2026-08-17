export const LINEAR_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// Why: ProjectCreateInput.id is documented as UUID v4 specifically, unlike the
// version-agnostic ids every other Linear write accepts.
const LINEAR_UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function isLinearUuid(value: string): boolean {
  return LINEAR_UUID_PATTERN.test(value)
}

export function isLinearUuidV4(value: string): boolean {
  return LINEAR_UUID_V4_PATTERN.test(value)
}
