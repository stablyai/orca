/** A reference to one task, the way ClickUp URLs and the API name it. */
export type ClickUpTaskReference =
  | { kind: 'id'; id: string }
  | { kind: 'custom-id'; customId: string; workspaceId: string | null }

const RAW_TASK_ID_PATTERN = /^[0-9a-z]{6,12}$/
const CUSTOM_TASK_ID_PATTERN = /^[A-Za-z][A-Za-z0-9]+-\d+$/
const WORKSPACE_ID_PATTERN = /^\d+$/
export const HTTP_URL_INPUT_PATTERN = /^https?:\/\//i

function referenceFromToken(
  token: string,
  workspaceId: string | null
): ClickUpTaskReference | null {
  if (CUSTOM_TASK_ID_PATTERN.test(token)) {
    return { kind: 'custom-id', customId: token.toUpperCase(), workspaceId }
  }
  return RAW_TASK_ID_PATTERN.test(token) ? { kind: 'id', id: token } : null
}

function referenceFromUrl(input: string): ClickUpTaskReference | null {
  let url: URL
  try {
    url = new URL(input)
  } catch {
    return null
  }
  if (url.hostname !== 'clickup.com' && !url.hostname.endsWith('.clickup.com')) {
    return null
  }
  const segments = url.pathname.split('/').filter(Boolean)
  if (segments[0] !== 't') {
    return null
  }
  const [first, second] = segments.slice(1)
  // /t/<workspaceId>/<customId> names the Workspace a custom id is scoped to.
  if (first && second && WORKSPACE_ID_PATTERN.test(first)) {
    return referenceFromToken(second, first)
  }
  return first ? referenceFromToken(first, null) : null
}

/** True when the input is a ClickUp task URL, as opposed to a bare id that may be a plain word. */
export function isClickUpTaskUrl(input: string): boolean {
  const trimmed = input.trim()
  return HTTP_URL_INPUT_PATTERN.test(trimmed) && referenceFromUrl(trimmed) !== null
}

/** Parses a task id, custom id or task URL; returns null when the input is none of them. */
export function parseClickUpTaskReference(input: string): ClickUpTaskReference | null {
  const trimmed = input.trim()
  if (!trimmed) {
    return null
  }
  return HTTP_URL_INPUT_PATTERN.test(trimmed)
    ? referenceFromUrl(trimmed)
    : referenceFromToken(trimmed, null)
}

/** ClickUp's Git integration links `CU-<id>` for raw task ids; custom ids such as ENG-7 (and an already prefixed id) carry a hyphen and are linked bare. */
export function clickupGitReferenceLabel(identifier: string): string {
  return identifier.includes('-') ? identifier : `CU-${identifier}`
}
