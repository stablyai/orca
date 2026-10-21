import { structuredAgentLabel } from './structured-agent-session-launch-label'
import { translate } from '@/i18n/i18n'
import {
  getStructuredLaunchStateBySessionId,
  notifyStructuredLaunchListeners
} from './structured-agent-session-launch-registry'
import { focusTerminalTabSurface } from './focus-terminal-tab-surface'
import type { Tab } from '../../../shared/tab-types'
import type { StructuredAgentLaunchSettlement } from '@/lib/structured-agent-launch-settlement'
import type { ProvisionalLaunchArgs } from './structured-agent-session-provisional-tab'
import { insertUnifiedTabAfterAnchor } from './unified-tab-anchor-insertion'
import { useAppStore } from '@/store'
import {
  notifyHostDeclined,
  openDeclinedStructuredLaunchTerminal,
  type StructuredLaunchTerminal
} from '@/lib/structured-agent-session-launch-admission'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import { structuredAgentSessionDraftScopeKey } from '@/components/native-chat/native-chat-composer-draft-store'
import { nativeChatComposerHasUserContent } from '@/components/native-chat/native-chat-pending-attachment-cache'
import { StructuredAgentSessionCreateRefusalError } from '@/lib/structured-agent-session-launch-errors'

export function openDeclinedTerminal(
  args: ProvisionalLaunchArgs,
  worktreeId: string,
  target: RuntimeClientTarget,
  activate?: false
): Promise<StructuredLaunchTerminal> | StructuredLaunchTerminal {
  if (args.onHostDeclined) {
    return args.onHostDeclined(target, activate)
  }
  const terminal = { ...args.declinedTerminal, ...(activate === false ? { activate } : {}) }
  return openDeclinedStructuredLaunchTerminal({
    plan: args.plan,
    worktreeId,
    ...(args.targetGroupId ? { targetGroupId: args.targetGroupId } : {}),
    terminal
  })
}

/** Only a foreground action without a prompt to deliver may open before admission. */
export function opensAtAction(args: ProvisionalLaunchArgs): boolean {
  const { plan } = args
  return (
    args.focusIntent !== undefined &&
    args.activate !== false &&
    !plan.resumeFrom &&
    (!plan.prompt?.trim() || plan.promptDelivery === 'draft')
  )
}

/** Prepare the replacement before relinquishing the source and its current composer content. */
export async function openTerminalForDeclinedChat(
  args: ProvisionalLaunchArgs,
  worktreeId: string,
  target: RuntimeClientTarget,
  tab: Tab,
  settlement: StructuredAgentLaunchSettlement
): Promise<StructuredAgentLaunchSettlement> {
  if (
    args.plan.requestedSurface === 'chat' ||
    settlement.kind !== 'failed' ||
    !(settlement.error instanceof StructuredAgentSessionCreateRefusalError) ||
    settlement.error.code !== 'structured_agent_session_unsupported'
  ) {
    return settlement
  }
  const source = () =>
    (useAppStore.getState().unifiedTabsByWorktree[worktreeId] ?? []).find(
      (candidate) => candidate.id === tab.id && candidate.entityId === tab.entityId
    )
  const launchState = getStructuredLaunchStateBySessionId(tab.entityId)
  if (!source() || launchState?.cancelled || args.hooks.signal?.aborted) {
    return settlement
  }
  const scopeKey = structuredAgentSessionDraftScopeKey(tab.entityId)
  const typed = nativeChatComposerHasUserContent(scopeKey)
  const attempt = launchState?.callers
  const terminal = await openDeclinedTerminal(args, worktreeId, target, false)
  const completed = terminal.completion
    ? await terminal.completion
    : {
        outcome: { status: terminal.opened ? 'created' : 'failed' },
        tabId: terminal.tabId
      }
  if (completed.outcome.status !== 'created') {
    return settlement
  }
  const state = useAppStore.getState()
  const current = source()
  const replacement = (state.unifiedTabsByWorktree[worktreeId] ?? []).find(
    (candidate) => candidate.id === completed.tabId
  )
  const ownsFailure =
    launchState &&
    getStructuredLaunchStateBySessionId(tab.entityId) === launchState &&
    launchState.callers === attempt &&
    attempt?.outcome === 'failed' &&
    !launchState.cancelled
  if (current && ownsFailure) {
    launchState.failure = {
      ...(launchState.failure?.code === 'structured_agent_session_unsupported'
        ? launchState.failure
        : {}),
      kind: 'refused',
      code: 'structured_agent_session_unsupported',
      causeText: replacement
        ? translate(
            'components.native-chat.structuredSessionHostDeclinedDescription',
            "This workspace can't run a {{value0}} chat.",
            { value0: structuredAgentLabel(args.plan.agent) }
          )
        : translate(
            'components.native-chat.structuredSessionTerminalNotVisible',
            "Orca opened {{value0}} in a terminal, but couldn't show it here when the launch finished. Your chat draft was kept.",
            { value0: structuredAgentLabel(args.plan.agent) }
          )
    }
    notifyStructuredLaunchListeners()
  }
  if (!replacement) {
    return settlement
  }
  if (!current || args.hooks.signal?.aborted || (launchState && !ownsFailure)) {
    notifyHostDeclined(args.plan.agent)
    return settlement
  }
  state.moveUnifiedTabToGroup(replacement.id, current.groupId, {
    activate: false,
    recordInteraction: false
  })
  if (Boolean(current.isPinned) !== Boolean(replacement.isPinned)) {
    const setPinned = current.isPinned ? state.pinTab : state.unpinTab
    setPinned(replacement.id, { recordInteraction: false })
  }
  insertUnifiedTabAfterAnchor(worktreeId, replacement.id, current.id)
  const placed = useAppStore.getState()
  const group = (placed.groupsByWorktree[worktreeId] ?? []).find((g) => g.id === current.groupId)
  if (
    !group ||
    group.tabOrder.indexOf(replacement.id) !== group.tabOrder.indexOf(current.id) + 1 ||
    typed ||
    nativeChatComposerHasUserContent(scopeKey)
  ) {
    notifyHostDeclined(args.plan.agent, false)
    return settlement
  }
  const foreground =
    placed.activeWorktreeId === worktreeId &&
    placed.activeGroupIdByWorktree[worktreeId] === current.groupId &&
    group.activeTabId === current.id
  if (current.customLabel !== null) {
    placed.setTabCustomTitle(replacement.entityId, current.customLabel, {
      recordInteraction: false
    })
  }
  if (current.color !== null) {
    placed.setTabColor(replacement.entityId, current.color, { recordInteraction: false })
  }
  placed.closeUnifiedTab(tab.id, { recordInteraction: false })
  if (foreground) {
    useAppStore.getState().setActiveTab(replacement.entityId)
    useAppStore.getState().activateTab(replacement.id)
    useAppStore.getState().setActiveTabType('terminal', worktreeId)
    focusTerminalTabSurface(replacement.id)
  }
  notifyHostDeclined(args.plan.agent)
  return { kind: 'terminal' }
}
