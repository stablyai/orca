import { translate } from '@/i18n/i18n'
export type WorkspaceCreateErrorDisplay = {
  title: string
  message: string
  help?: string
}

const MISSING_BASE_REF_ANCHOR = 'could not resolve a default base ref'
const BASE_REF_LOOKUP_FAILED_ANCHOR = 'could not look up the default base branch'

export function formatWorkspaceCreateError(error: unknown): WorkspaceCreateErrorDisplay {
  const message =
    error instanceof Error
      ? error.message
      : translate('components.toastFallbacks.worktreeCreateFailed', 'Failed to create worktree.')

  const normalizedMessage = message.toLowerCase()
  if (normalizedMessage.includes(BASE_REF_LOOKUP_FAILED_ANCHOR)) {
    return {
      title: translate(
        'components.toastFallbacks.baseBranchLookupFailedTitle',
        'Could not look up the base branch'
      ),
      message: translate(
        'components.toastFallbacks.baseBranchLookupFailedMessage',
        "Git failed or timed out while looking up this repo's default base branch."
      ),
      help: translate(
        'components.toastFallbacks.baseBranchLookupFailedHelp',
        'Try again, or select a base branch in Create From.'
      )
    }
  }
  if (normalizedMessage.includes(MISSING_BASE_REF_ANCHOR)) {
    return {
      title: translate('auto.lib.workspace.create.error.format.64555d0014', 'No base branch found'),
      message: translate(
        'auto.lib.workspace.create.error.format.37cf0bc991',
        'Orca could not resolve a usable base ref for this workspace.'
      ),
      help: translate(
        'components.toastFallbacks.missingBaseBranchHelp',
        'Create an initial commit (for example on main), or select an existing branch in Create From, then try again.'
      )
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
