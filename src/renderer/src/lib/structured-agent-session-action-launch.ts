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
import type { OpenedAgentSessionTab } from './structured-agent-session-tab-open-through-layout-owner'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/layout-owner-switch'
import { sendLayoutCommandToOwner } from '@/runtime/layout-owner-command'
import {
  declinedTerminalCanOpen,
  notifyHostDeclined,
  openDeclinedStructuredLaunchTerminal,
  type StructuredLaunchTerminal
} from '@/lib/structured-agent-session-launch-admission'
import type { ExecutionHostId } from '../../../shared/execution-host'
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
  { executionHostId, target }: { executionHostId: ExecutionHostId; target: RuntimeClientTarget },
  tab: OpenedAgentSessionTab,
  settlement: StructuredAgentLaunchSettlement
): Promise<StructuredAgentLaunchSettlement> {
  if (
    args.plan.requestedSurface === 'chat' ||
    !declinedTerminalCanOpen(
      args.plan.agent,
      worktreeId,
      executionHostId,
      args.declinedOpensCallerSurface
    ) ||
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
  // Switch point: main places and pins the tab in one step; a pin sent alone would re-sort it.
  if (ORCA_LAYOUT_OWNER_IS_MAIN) {
    await placeReplacementThroughMain(worktreeId, replacement, current)
  } else {
    placeReplacementAfterSource(worktreeId, replacement, current)
  }
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
  const showReplacement = (): void => {
    useAppStore.getState().setActiveTab(replacement.entityId)
    useAppStore.getState().activateTab(replacement.id)
    useAppStore.getState().setActiveTabType('terminal', worktreeId)
    focusTerminalTabSurface(replacement.id)
  }
  // Switch-on, main's close lands later and shows the group's active tab: make it the terminal.
  const showsFirst = foreground && ORCA_LAYOUT_OWNER_IS_MAIN
  if (showsFirst) {
    showReplacement()
  }
  placed.closeUnifiedTab(tab.id, { recordInteraction: false })
  if (foreground && !showsFirst) {
    showReplacement()
  }
  notifyHostDeclined(args.plan.agent)
  return { kind: 'terminal' }
}

/** The terminal goes right after the declined chat, pinned as the chat is. */
function placeReplacementAfterSource(worktreeId: string, replacement: Tab, source: Tab): void {
  const state = useAppStore.getState()
  state.moveUnifiedTabToGroup(replacement.id, source.groupId, {
    activate: false,
    recordInteraction: false
  })
  if (Boolean(source.isPinned) !== Boolean(replacement.isPinned)) {
    const setPinned = source.isPinned ? state.pinTab : state.unpinTab
    setPinned(replacement.id, { recordInteraction: false })
  }
  insertUnifiedTabAfterAnchor(worktreeId, replacement.id, source.id)
}

/** One main move puts the terminal after the chat with the chat's pin; resolves once drawn. */
function placeReplacementThroughMain(
  worktreeId: string,
  replacement: Tab,
  source: Tab
): Promise<void> {
  const state = useAppStore.getState()
  const rows = new Set((state.unifiedTabsByWorktree[worktreeId] ?? []).map((tab) => tab.id))
  // Main's index counts only tabs it draws: a hidden launch slot has no row and is not in main.
  const order = (state.groupsByWorktree[worktreeId] ?? [])
    .find((group) => group.id === source.groupId)
    ?.tabOrder.filter((id) => id !== replacement.id && rows.has(id))
  return new Promise((resolve) => {
    const placeHere = (): void => {
      placeReplacementAfterSource(worktreeId, replacement, source)
      resolve()
    }
    const sent = sendLayoutCommandToOwner(
      worktreeId,
      {
        type: 'moveTab',
        tabId: replacement.id,
        toGroupId: source.groupId,
        index: (order?.indexOf(source.id) ?? -1) + 1,
        isPinned: Boolean(source.isPinned)
      },
      { apply: () => resolve(), asToday: placeHere, refused: () => resolve() }
    )
    if (!sent) {
      placeHere()
    }
  })
}
