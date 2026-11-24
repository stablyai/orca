import type {
  StructuredSessionOpenFailure,
  StructuredSessionRemovedWorkspaceKind
} from './open-structured-agent-session'

export type StructuredSessionWorkspaceRemovedDetails = {
  workspaceKind: StructuredSessionRemovedWorkspaceKind
}

export function readStructuredSessionWorkspaceRemovedDetails(
  value: unknown
): StructuredSessionWorkspaceRemovedDetails | undefined {
  if (value !== null && typeof value === 'object' && 'workspaceKind' in value) {
    const { workspaceKind } = value
    if (
      workspaceKind === 'folder' ||
      workspaceKind === 'git-worktree' ||
      workspaceKind === 'project'
    ) {
      return { workspaceKind }
    }
  }
  return undefined
}

/** Reveal answered but no tab followed: nothing proves the chat is gone. */
export const TAB_NEVER_APPEARED: StructuredSessionOpenFailure = {
  reason: 'unreachable',
  beforeEffects: false,
  detail: 'The chat tab did not appear after it was revealed.'
}

/** A failure that proves nothing about the chat, carrying its raw cause for display only. */
export function unreachableOpenFailure(error: unknown): StructuredSessionOpenFailure {
  const detail = openFailureDetail(error)
  return { reason: 'unreachable', beforeEffects: false, ...(detail ? { detail } : {}) }
}

function openFailureDetail(error: unknown): string | undefined {
  const code =
    error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
      ? error.code
      : undefined
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : error !== null &&
            typeof error === 'object' &&
            'message' in error &&
            typeof error.message === 'string'
          ? error.message
          : undefined
  return [code, message].filter(Boolean).join(': ') || undefined
}
