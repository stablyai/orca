import { openDesktopStructuredSessionInteraction } from './open-existing-structured-session'
import type { StructuredSessionOpenAdapterDeps } from './open-existing-structured-session'
import { showAgentPaneUnavailable } from '@/components/terminal-pane/agent-status/stale-agent-row'
import { translate } from '@/i18n/i18n'
import { toast } from 'sonner'
import { activateAndRevealWorktree } from '../../workspace/activation/worktree-activation'
import { activateWslMovedWorkspace } from '../../workspace/activation/wsl-moved-chat-activation'
import { useAppStore } from '@/store/index'
import { runtimeEnvironmentIdOrLocalUnlessTwin } from '../../workspace/ownership/worktree-runtime-owner'
import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../../../shared/execution-host/execution-host'
import { readBotGroups } from '../../bot-group-catalog-snapshot'
import { openBotGroupRoom } from '../../bot-group-catalog'
import { botGroupRoomOfRow } from '../../bot-group-room-history'
import type { AiVaultSession } from '../../../../../shared/ai-vault/contracts/ai-vault-types'
import type {
  StructuredSessionOpenSource,
  StructuredSessionOpenResult,
  StructuredSessionOpenDeps
} from '../../../../../shared/agent-session/view/open-structured-agent-session'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'

type StructuredSessionActivationDeps = StructuredSessionOpenAdapterDeps & {
  unavailable: (agent?: string) => void
  gone: (agent?: string) => void
  hostCannotOpen: (agent?: string) => void
}

/** `terminalGone` replaces the shared pane-unavailable notice for callers that name the agent themselves;
 *  `notLocated` the one for an agent its host answered it cannot find. */
export type StructuredSessionOpenFeedback = Pick<
  StructuredSessionActivationDeps,
  'unavailable' | 'gone' | 'hostCannotOpen'
> & { terminalGone?: () => void; notLocated?: (agent?: string) => void }

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
    ),
  notLocated: (agent?: string) =>
    agent
      ? translate(
          'auto.lib.activateAiVaultStructuredSession.notLocatedNamed',
          "Orca can't find where {{agent}} is running, so it can't open it.",
          { agent }
        )
      : translate(
          'auto.lib.activateAiVaultStructuredSession.notLocated',
          "Orca can't find where this agent is running, so it can't open it."
        )
}

export const structuredSessionOpenFeedback: StructuredSessionOpenFeedback = {
  unavailable: () => toast.error(structuredSessionOpenFeedbackText.unavailable()),
  gone: () => toast.error(structuredSessionOpenFeedbackText.gone()),
  hostCannotOpen: () => toast.error(structuredSessionOpenFeedbackText.hostCannotOpen())
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
  // A group member's session reopens the room it talks in, not the member's own chat.
  const room = botGroupRoomOfRow(readBotGroups(), session)
  if (room) {
    await openBotGroupRoom(room.group, room.roomId, room.label)
    return true
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
  locate?: StructuredSessionOpenDeps['locate'],
  feedback?: StructuredSessionOpenFeedback
): Promise<StructuredSessionOpenResult> {
  // Read when the open starts: the selection may move before it settles.
  const pairedHostId = openingPairedHostId(source, host)
  return openDesktopStructuredSessionInteraction(source, {
    target: host,
    deps,
    locate,
    present: (result) =>
      presentDesktopStructuredSession(
        result,
        source,
        feedback ?? deps ?? structuredSessionOpenFeedback,
        pairedHostId
      )
  })
}

/** The host an open targets, so its same-id workspace is selected, never a twin on another host. */
function openingPairedHostId(
  source: StructuredSessionOpenSource,
  host: RuntimeClientTarget | undefined
): ExecutionHostId | null {
  if (host) {
    return host.kind === 'environment'
      ? toRuntimeExecutionHostId(host.environmentId)
      : LOCAL_EXECUTION_HOST_ID
  }
  const workspace =
    source.kind === 'history'
      ? source.structuredSession.workspaceId
      : source.kind === 'notification'
        ? source.worktreeId
        : null
  const environmentId = workspace
    ? runtimeEnvironmentIdOrLocalUnlessTwin(useAppStore.getState(), workspace)
    : null
  return environmentId ? toRuntimeExecutionHostId(environmentId) : null
}

/** Whether the selection shows another host's copy; a local open only moves off a paired twin. */
function selectsOtherHost(
  selected: ExecutionHostId | null,
  wanted: ExecutionHostId | null,
  workspace: string
): boolean {
  if (wanted === null) {
    return false
  }
  if (wanted === LOCAL_EXECUTION_HOST_ID) {
    return parseExecutionHostId(selected)?.kind === 'runtime'
  }
  if (selected !== null) {
    return selected !== wanted
  }
  // An unstamped selection still names the wanted host when only that host has this workspace.
  const owner = runtimeEnvironmentIdOrLocalUnlessTwin(useAppStore.getState(), workspace)
  return !owner || toRuntimeExecutionHostId(owner) !== wanted
}

function presentDesktopStructuredSession(
  result: StructuredSessionOpenResult,
  source: StructuredSessionOpenSource,
  deps: StructuredSessionOpenFeedback,
  pairedHostId: ExecutionHostId | null
): void {
  if (result.kind === 'opened') {
    const workspace = result.target.worktreeId
    const { activeWorktreeId, activeView, activeWorkspaceExecutionHostId } = useAppStore.getState()
    // Settings or another page may cover the chat's own workspace; its tab is selected but not shown.
    // A same-id twin on another host can be selected while the chat lives on this one.
    const otherHostSelected = selectsOtherHost(
      activeWorkspaceExecutionHostId,
      pairedHostId,
      workspace
    )
    const onPairedHost = pairedHostId !== null && pairedHostId !== LOCAL_EXECUTION_HOST_ID
    if (
      (activeWorktreeId !== workspace || activeView !== 'terminal' || otherHostSelected) &&
      // A moved WSL workspace is this machine's; it never stands in for a paired host's copy.
      (onPairedHost || !activateWslMovedWorkspace(workspace))
    ) {
      // A local open names its host only to move off a paired twin, as every other local open does.
      if (pairedHostId && (onPairedHost || otherHostSelected)) {
        activateAndRevealWorktree(workspace, { executionHostId: pairedHostId })
      } else {
        activateAndRevealWorktree(workspace)
      }
    }
  } else if (result.kind === 'failed') {
    const agent = source.kind === 'sender' ? (source.displayName ?? '') : (source.agent ?? '')
    if (result.failure.reason === 'workspace-missing') {
      toast.error(
        result.failure.workspaceKind === 'folder'
          ? translate(
              'auto.lib.activateAiVaultStructuredSession.folderWorkspaceRemoved',
              'The folder workspace was removed.'
            )
          : result.failure.workspaceKind === 'project'
            ? translate(
                'auto.lib.activateAiVaultStructuredSession.projectRemoved',
                'The project was removed from Orca.'
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
    } else if (result.failure.reason === 'unknown' && source.kind === 'sender') {
      // The host answered and found no chat or terminal for this agent: no session is pending.
      if (deps.notLocated) {
        deps.notLocated(agent)
      } else {
        toast.error(structuredSessionOpenFeedbackText.notLocated(agent))
      }
    } else {
      deps.unavailable(agent)
    }
  }
}
