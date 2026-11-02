import type { AiVaultSession } from '../../../shared/ai-vault-types'
import type {
  StructuredSessionOpenSource,
  StructuredSessionOpenResult,
  StructuredSessionOpenDeps
} from '../../../shared/open-structured-agent-session'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import {
  openDesktopStructuredSessionInteraction,
  desktopStructuredSessionOpenDeps,
  type StructuredSessionOpenAdapterDeps
} from './open-existing-structured-session'
import { showAgentPaneUnavailable } from '@/components/terminal-pane/stale-agent-row'
import { translate } from '@/i18n/i18n'
import { toast } from 'sonner'
import { showStructuredChatWorkspace } from './structured-chat-workspace-navigation'
import {
  structuredAgentSessionTargetForHost,
  executionHostIdForStructuredTarget
} from '@/runtime/structured-agent-session-owner'
export {
  revealStructuredSession,
  type StructuredSessionRevealOutcome
} from './open-existing-structured-session'

type StructuredSessionActivationDeps = StructuredSessionOpenAdapterDeps & {
  unavailable: (agent?: string) => void
  gone: (agent?: string) => void
  hostCannotOpen: (agent?: string) => void
}

/** `terminalGone` replaces the shared pane-unavailable notice for callers that name the agent themselves. */
export type StructuredSessionOpenFeedback = Pick<
  StructuredSessionActivationDeps,
  'unavailable' | 'gone' | 'hostCannotOpen'
> & { terminalGone?: () => void }

/** The open remedies' words, so labelled opens (the orchestration panel) say the same thing. */
export const structuredSessionOpenFeedbackText = {
  unavailable: () =>
    translate(
      'auto.lib.activateAiVaultStructuredSession.unavailable',
      'The structured agent session is not available yet. Retry in a moment.'
    ),
  gone: () =>
    translate(
      'auto.lib.activateAiVaultStructuredSession.gone',
      'This chat is no longer on this host, so it cannot be reopened here.'
    ),
  hostCannotOpen: () =>
    translate(
      'auto.lib.activateAiVaultStructuredSession.hostCannotOpen',
      "This chat can't be reopened until Orca is updated."
    )
}

export const structuredSessionOpenFeedback: StructuredSessionOpenFeedback = {
  unavailable: () => toast.error(structuredSessionOpenFeedbackText.unavailable()),
  gone: () => toast.error(structuredSessionOpenFeedbackText.gone()),
  hostCannotOpen: () => toast.error(structuredSessionOpenFeedbackText.hostCannotOpen())
}

/** Read only structuredSession so history clicks and drag payloads follow the same reveal path. */
export async function activateAiVaultStructuredSession(
  session: Pick<AiVaultSession, 'structuredSession'> &
    Partial<Pick<AiVaultSession, 'executionHostId'>> & { agent?: string },
  deps?: StructuredSessionActivationDeps,
  target?: RuntimeClientTarget
): Promise<boolean> {
  if (!session.structuredSession) {
    return false
  }
  const owner =
    target ??
    (session.executionHostId
      ? structuredAgentSessionTargetForHost(session.executionHostId)
      : undefined)
  if (owner === null) {
    ;(deps ?? structuredSessionOpenFeedback).unavailable(session.agent)
    return false
  }
  const result = await openDesktopStructuredSession(
    { kind: 'history', structuredSession: session.structuredSession, agent: session.agent },
    owner,
    deps
  )
  return result.kind === 'opened'
}

export function openDesktopStructuredSession(
  source: StructuredSessionOpenSource,
  host?: RuntimeClientTarget,
  deps?: StructuredSessionActivationDeps,
  locate?: StructuredSessionOpenDeps['locate'],
  feedback?: StructuredSessionOpenFeedback
): Promise<StructuredSessionOpenResult> {
  const navigation = { reported: false }
  // Navigate on every attempt: the opener awaits between them, and the registration can change.
  const activate: StructuredSessionOpenAdapterDeps['activate'] = (args) =>
    showStructuredChatWorkspace(
      args.worktreeId,
      args.target ? executionHostIdForStructuredTarget(args.target) : undefined,
      navigation
    ) && desktopStructuredSessionOpenDeps.activate(args)
  return openDesktopStructuredSessionInteraction(source, {
    target: host,
    deps: deps ?? { ...desktopStructuredSessionOpenDeps, activate },
    locate,
    present: (result) => {
      if (!navigation.reported) {
        presentDesktopStructuredSession(
          result,
          source,
          feedback ?? deps ?? structuredSessionOpenFeedback
        )
      }
    }
  })
}

function presentDesktopStructuredSession(
  result: StructuredSessionOpenResult,
  source: StructuredSessionOpenSource,
  deps: StructuredSessionOpenFeedback
): void {
  if (result.kind === 'failed') {
    const agent = source.kind === 'sender' ? (source.displayName ?? '') : (source.agent ?? '')
    if (result.failure.reason === 'workspace-missing') {
      toast.error(
        result.failure.workspaceKind === 'folder'
          ? translate(
              'auto.lib.activateAiVaultStructuredSession.folderWorkspaceRemoved',
              'The folder workspace was removed.'
            )
          : translate(
              'auto.lib.activateAiVaultStructuredSession.worktreeDeleted',
              'The worktree was deleted.'
            )
      )
    } else if (result.failure.reason === 'gone') {
      if (result.failure.surface === 'terminal') {
        const terminalGone = deps.terminalGone ?? showAgentPaneUnavailable
        terminalGone()
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
