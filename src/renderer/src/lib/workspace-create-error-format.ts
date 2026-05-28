export type WorkspaceCreateErrorDisplay = {
  title: string
  message: string
  help?: string
}

const MISSING_BASE_REF_ANCHOR = 'could not resolve a default base ref'

export function formatWorkspaceCreateError(error: unknown): WorkspaceCreateErrorDisplay {
  const message = error instanceof Error ? error.message : 'Failed to create worktree.'

  if (message.toLowerCase().includes(MISSING_BASE_REF_ANCHOR)) {
    return {
      title: 'No base branch found',
      message: 'Orca could not resolve a usable base ref for this workspace.',
      help: 'Create an initial commit (for example on main), or select an existing branch in Create From, then try again.'
    }
  }

  return {
    title: message,
    message
  }
}

export function getWorkspaceCreateErrorToastMessage(error: WorkspaceCreateErrorDisplay): string {
  return error.help ? error.title : error.message
}
