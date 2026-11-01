import type { AiVaultSession } from '../../../shared/ai-vault-types'
import type {
  StructuredSessionOpenSource,
  StructuredSessionOpenResult,
  StructuredSessionOpenDeps
} from '../../../shared/open-structured-agent-session'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import {
  openDesktopStructuredSessionInteraction,
  type StructuredSessionOpenAdapterDeps
} from './open-existing-structured-session'
import { showAgentPaneUnavailable } from '@/components/terminal-pane/stale-agent-row'
import { translate } from '@/i18n/i18n'
import { toast } from 'sonner'
import { activateAndRevealWorktree } from './worktree-activation'
import { activateWslMovedWorkspace } from './wsl-moved-chat-activation'
import { useAppStore } from '@/store'
export {
  revealStructuredSession,
  type StructuredSessionRevealOutcome
} from './open-existing-structured-session'

type StructuredSessionActivationDeps = StructuredSessionOpenAdapterDeps & {
  unavailable: (agent?: string) => void
  gone: (agent?: string) => void
  hostCannotOpen: (agent?: string) => void
}

export const structuredSessionOpenFeedback: Pick<
  StructuredSessionActivationDeps,
  'unavailable' | 'gone' | 'hostCannotOpen'
> = {
  unavailable: () =>
    toast.error(
      translate(
        'auto.lib.activateAiVaultStructuredSession.unavailable',
        'The structured agent session is not available yet. Retry in a moment.'
      )
    ),
  gone: () =>
    toast.error(
      translate(
        'auto.lib.activateAiVaultStructuredSession.gone',
        'This chat is no longer on this host, so it cannot be reopened here.'
      )
    ),
  hostCannotOpen: () =>
    toast.error(
      translate(
        'auto.lib.activateAiVaultStructuredSession.hostCannotOpen',
        "This chat can't be reopened until Orca is updated."
      )
    )
}

/** Read only structuredSession so history clicks and drag payloads follow the same reveal path. */
export async function activateAiVaultStructuredSession(
  session: Pick<AiVaultSession, 'structuredSession'> & { agent?: string },
  deps?: StructuredSessionActivationDeps,
  target?: RuntimeClientTarget
): Promise<boolean> {
  if (!session.structuredSession) {
    return false
  }
  await openDesktopStructuredSession(
    { kind: 'history', structuredSession: session.structuredSession, agent: session.agent },
    target,
    deps
  )
  return true
}

export function openDesktopStructuredSession(
  source: StructuredSessionOpenSource,
  host?: RuntimeClientTarget,
  deps?: StructuredSessionActivationDeps,
  locate?: StructuredSessionOpenDeps['locate']
): Promise<StructuredSessionOpenResult> {
  return openDesktopStructuredSessionInteraction(source, {
    target: host,
    deps,
    locate,
    present: (result) =>
      presentDesktopStructuredSession(result, source, deps ?? structuredSessionOpenFeedback)
  })
}

function presentDesktopStructuredSession(
  result: StructuredSessionOpenResult,
  source: StructuredSessionOpenSource,
  deps: Pick<StructuredSessionActivationDeps, 'unavailable' | 'gone' | 'hostCannotOpen'>
): void {
  if (result.kind === 'opened') {
    const workspace = result.target.worktreeId
    if (
      useAppStore.getState().activeWorktreeId !== workspace &&
      !activateWslMovedWorkspace(workspace)
    ) {
      activateAndRevealWorktree(workspace)
    }
  } else if (result.kind === 'failed') {
    const agent = source.kind === 'sender' ? (source.displayName ?? '') : (source.agent ?? '')
    if (result.failure.reason === 'workspace-missing') {
      toast.error(
        translate(
          'auto.store.slices.worktrees.c6cf133786',
          'This workspace is no longer available.'
        )
      )
    } else if (result.failure.reason === 'gone') {
      if (result.failure.surface === 'terminal') {
        showAgentPaneUnavailable()
      } else {
        deps.gone(agent)
      }
    } else if (result.failure.reason === 'unsupported') {
      deps.hostCannotOpen(agent)
    } else {
      deps.unavailable(agent)
    }
  }
}
