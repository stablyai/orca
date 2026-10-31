import { toast } from 'sonner'
import type { AiVaultSession } from '../../../shared/ai-vault-types'
import { translate } from '@/i18n/i18n'
import { activateAndRevealWorktree } from './worktree-activation'
import { activateWslMovedWorkspace } from './wsl-moved-chat-activation'
import { useAppStore } from '@/store'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import {
  openExistingStructuredSession,
  type StructuredSessionOpenDeps
} from './open-existing-structured-session'
export {
  revealStructuredSession,
  type StructuredSessionRevealOutcome
} from './open-existing-structured-session'

type StructuredSessionActivationDeps = StructuredSessionOpenDeps & {
  unavailable: () => void
  gone: () => void
  hostCannotOpen: () => void
}

export const structuredSessionOpenFeedback: Pick<
  StructuredSessionActivationDeps,
  'unavailable' | 'gone' | 'hostCannotOpen'
> = {
  unavailable: () => {
    toast.error(
      translate(
        'auto.lib.activateAiVaultStructuredSession.unavailable',
        'The structured agent session is not available yet. Retry in a moment.'
      )
    )
  },
  // A reveal refusal is terminal; retry advice would send the user in circles.
  gone: () => {
    toast.error(
      translate(
        'auto.lib.activateAiVaultStructuredSession.gone',
        'This chat is no longer on this host, so it cannot be reopened here.'
      )
    )
  },
  // Name the update remedy without blaming a machine: either side or its adapter may be incompatible, and the chat still exists.
  hostCannotOpen: () => {
    toast.error(
      translate(
        'auto.lib.activateAiVaultStructuredSession.hostCannotOpen',
        "This chat can't be reopened until Orca is updated."
      )
    )
  }
}

/** Read only structuredSession so history clicks and drag payloads follow the same reveal path. */
export async function activateAiVaultStructuredSession(
  session: Pick<AiVaultSession, 'structuredSession'>,
  deps?: StructuredSessionActivationDeps,
  target?: RuntimeClientTarget
): Promise<boolean> {
  const structured = session.structuredSession
  if (!structured) {
    return false
  }
  const feedback = deps ?? structuredSessionOpenFeedback
  await openExistingStructuredSession(structured, {
    target,
    deps,
    present: (outcome) => {
      if (outcome === 'activated') {
        // A moved project's chat opens under its retained entry; the catalog does not list it.
        if (
          useAppStore.getState().activeWorktreeId !== structured.workspaceId &&
          !activateWslMovedWorkspace(structured.workspaceId)
        ) {
          activateAndRevealWorktree(structured.workspaceId)
        }
      } else if (outcome === 'gone') {
        feedback.gone()
      } else if (outcome === 'host-cannot-open') {
        feedback.hostCannotOpen()
      } else {
        feedback.unavailable()
      }
    }
  })
  return true
}
