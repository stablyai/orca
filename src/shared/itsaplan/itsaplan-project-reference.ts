export type ItsaplanProjectReference = {
  instanceId: string
  projectRef: string
  projectKey: string
}

// null clears the default, undefined means the value is malformed and should be ignored.
export function normalizeItsaplanProjectReference(
  value: unknown
): ItsaplanProjectReference | null | undefined {
  if (value === null) {
    return null
  }
  if (!value || typeof value !== 'object') {
    return undefined
  }
  const { instanceId, projectRef, projectKey } = value as Record<string, unknown>
  if (
    typeof instanceId !== 'string' ||
    !instanceId.trim() ||
    typeof projectRef !== 'string' ||
    !projectRef.trim() ||
    typeof projectKey !== 'string' ||
    !projectKey.trim()
  ) {
    return undefined
  }
  return {
    instanceId: instanceId.trim(),
    projectRef: projectRef.trim(),
    projectKey: projectKey.trim()
  }
}
