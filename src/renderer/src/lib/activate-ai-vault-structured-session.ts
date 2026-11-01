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
import { activateAndRevealWorkspace } from './worktree-activation'
import { activateWslMovedWorkspace } from './wsl-moved-chat-activation'
import { useAppStore } from '@/store'
import {
  structuredAgentSessionTargetForHost,
  executionHostIdForStructuredTarget
} from '@/runtime/structured-agent-session-owner'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import { selectFolderWorkspaces } from '@/store/workspace-record-selectors'
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
  session: Pick<AiVaultSession, 'structuredSession'> &
    Partial<Pick<AiVaultSession, 'executionHostId' | 'agent'>>,
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
  locate?: StructuredSessionOpenDeps['locate']
): Promise<StructuredSessionOpenResult> {
  const navigated = new Map<string, boolean>()
  let navigationReported = false
  const activate: StructuredSessionOpenAdapterDeps['activate'] = (args) => {
    let opened = navigated.get(args.worktreeId)
    if (opened === undefined) {
      const scope = parseWorkspaceKey(args.worktreeId)
      const registeredFolder =
        scope?.type === 'folder' &&
        selectFolderWorkspaces(useAppStore.getState()).some(
          (row) => row.id === scope.folderWorkspaceId
        )
      opened =
        activateWslMovedWorkspace(args.worktreeId) ||
        activateAndRevealWorkspace(args.worktreeId, {
          providesInitialSurface: true,
          ...(args.target
            ? { executionHostId: executionHostIdForStructuredTarget(args.target) }
            : {})
        }) !== false
      navigated.set(args.worktreeId, opened)
      navigationReported ||= !opened && !!registeredFolder
    }
    return opened && desktopStructuredSessionOpenDeps.activate(args)
  }
  return openDesktopStructuredSessionInteraction(source, {
    target: host,
    deps: deps ?? { ...desktopStructuredSessionOpenDeps, activate },
    locate,
    present: (result) => {
      if (!navigationReported) {
        presentDesktopStructuredSession(result, source, deps ?? structuredSessionOpenFeedback)
      }
    }
  })
}

function presentDesktopStructuredSession(
  result: StructuredSessionOpenResult,
  source: StructuredSessionOpenSource,
  deps: Pick<StructuredSessionActivationDeps, 'unavailable' | 'gone' | 'hostCannotOpen'>
): void {
  if (result.kind === 'failed') {
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
