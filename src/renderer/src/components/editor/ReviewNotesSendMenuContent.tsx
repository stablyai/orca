import React, { useCallback, useMemo } from 'react'
import { toast } from 'sonner'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import { QuickLaunchAgentMenuItems } from '@/components/tab-bar/QuickLaunchButton'
import { AgentStateDot, agentStateLabel, type AgentDotState } from '@/components/AgentStateDot'
import { AgentIcon } from '@/lib/agent-catalog'
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator
} from '@/components/ui/dropdown-menu'
import { focusTerminalTabSurface } from '@/lib/focus-terminal-tab-surface'
import {
  activeAgentNotesSendFailureMessage,
  sendNotesToActiveAgentSession,
  type ActiveAgentNotesSendResult
} from '@/lib/active-agent-note-send'
import {
  deriveNotesSendAgentTargets,
  type NotesSendAgentTarget
} from '@/lib/notes-send-agent-targets'
import {
  agentKindForAgentType,
  formatAgentTypeLabel,
  agentTypeToIconAgent
} from '@/lib/agent-status'
import { agentRowOwnsTabName, agentRowPrimaryLabel } from '@/lib/agent-row-display-name'
import { getAgentRowConversationName } from '../../../../shared/agent-row-conversation-name'
import type { AgentType } from '../../../../shared/agent-status-types'
import { track } from '@/lib/telemetry'
import { useNow } from '@/components/dashboard/useNow'
import type { DashboardAgentRow as DashboardAgentRowData } from '@/components/dashboard/useDashboardData'
import { selectLivePtyIdsForWorktree } from '@/components/sidebar/worktree-card-status-inputs'
import { useWorktreeAgentRows } from '@/components/sidebar/useWorktreeAgentRows'
import type { LaunchSource } from '../../../../shared/telemetry-events'
import type { AgentStatusState } from '../../../../shared/agent-status-types'
import { translate } from '@/i18n/i18n'

type OrderedSendTarget = {
  target: NotesSendAgentTarget
  agent: DashboardAgentRowData | null
  name: string
}

export function ReviewNotesSendMenuContent({
  worktreeId,
  groupId,
  prompt,
  promptDelivery = 'submit-after-ready',
  launchSource = 'notes_send',
  onPromptDelivered
}: {
  worktreeId: string
  groupId: string
  prompt: string
  promptDelivery?: 'auto-submit' | 'draft' | 'submit-after-ready'
  launchSource?: LaunchSource
  onPromptDelivered?: () => void
}): React.JSX.Element {
  const hasPrompt = prompt.trim().length > 0

  // Why: enumerate every running agent of the worktree so the user can target
  // any of them — not only the focused pane. Derive from store slices in a memo
  // to avoid the new-array identity churn of selecting the function result.
  const agentStatusByPaneKey = useAppStore((s) => s.agentStatusByPaneKey)
  const tabsByWorktree = useAppStore((s) => s.tabsByWorktree)
  const terminalLayoutsByTabId = useAppStore((s) => s.terminalLayoutsByTabId)
  const ptyIdsByTabId = useAppStore(useShallow((s) => selectLivePtyIdsForWorktree(s, worktreeId)))
  const runtimePaneTitlesByTabId = useAppStore((s) => s.runtimePaneTitlesByTabId)
  const generatedTabTitlesEnabled = useAppStore((s) => s.settings?.tabAutoGenerateTitle === true)
  const agentStatusEpoch = useAppStore((s) => s.agentStatusEpoch)
  const agentRows = useWorktreeAgentRows(worktreeId)
  const now = useNow(30_000)
  const sendTargets = useMemo(() => {
    void agentStatusEpoch
    return deriveNotesSendAgentTargets(
      {
        agentStatusByPaneKey,
        tabsByWorktree,
        terminalLayoutsByTabId,
        ptyIdsByTabId,
        runtimePaneTitlesByTabId
      },
      worktreeId
    )
  }, [
    // Why: stale-boundary timers bump this epoch without replacing the
    // status map, so eligibility must derive again when freshness flips.
    agentStatusEpoch,
    agentStatusByPaneKey,
    tabsByWorktree,
    terminalLayoutsByTabId,
    runtimePaneTitlesByTabId,
    ptyIdsByTabId,
    worktreeId
  ])
  const orderedSendTargets = useMemo(
    () => orderSendTargetsByWorktreeAgentRows(sendTargets, agentRows, generatedTabTitlesEnabled),
    [agentRows, sendTargets, generatedTabTitlesEnabled]
  )

  const runNotesSend = useCallback(
    (
      send: () => Promise<ActiveAgentNotesSendResult>,
      onSent: () => void,
      options: { explicitTarget?: boolean } = {}
    ) => {
      const pending = toast.loading(
        translate(
          'auto.components.editor.ReviewNotesSendMenuContent.50f7e753ea',
          'Sending notes...'
        )
      )

      void send()
        .then((result) => {
          if (result.status === 'sent') {
            onSent()
            toast.success(
              translate(
                'auto.components.editor.ReviewNotesSendMenuContent.bb9c69a0c9',
                'Notes sent.'
              )
            )
            return
          }

          toast.message(
            activeAgentNotesSendFailureMessage(result.status, {
              explicitTarget: options.explicitTarget
            })
          )
        })
        .catch((error) => {
          console.error('Failed to send notes:', error)
          toast.error(
            translate(
              'auto.components.editor.ReviewNotesSendMenuContent.f5096c6e4e',
              'Could not send notes.'
            )
          )
        })
        .finally(() => {
          toast.dismiss(pending)
        })
    },
    []
  )

  const sendToAgentTarget = useCallback(
    (target: NotesSendAgentTarget) => {
      if (!hasPrompt || target.status !== 'eligible') {
        return
      }

      const currentEligibility = resolveCurrentSendTargetEligibility(target, worktreeId)
      if (currentEligibility.status !== 'eligible') {
        toast.message(currentEligibility.disabledReason)
        return
      }

      runNotesSend(
        () =>
          sendNotesToActiveAgentSession({
            worktreeId,
            prompt,
            noteTarget: { tabId: target.tabId, leafId: target.leafId }
          }),
        () => {
          onPromptDelivered?.()
          // Why: mirror the sidebar send-target telemetry so dropdown-routed
          // follow-up notes show up identically on `agent_prompt_sent`.
          track('agent_prompt_sent', {
            agent_kind: agentKindForAgentType(target.agentType),
            launch_source: launchSource,
            request_kind: 'followup'
          })
        },
        { explicitTarget: true }
      )
    },
    [hasPrompt, runNotesSend, worktreeId, prompt, onPromptDelivered, launchSource]
  )

  return (
    <>
      <DropdownMenuLabel>
        {translate('auto.components.editor.ReviewNotesSendMenuContent.03378aea75', 'Send notes to')}
      </DropdownMenuLabel>
      {orderedSendTargets.map(({ target, agent, name }) => (
        <AgentTargetMenuItem
          key={target.paneKey}
          target={target}
          agent={agent}
          name={name}
          now={now}
          disabled={!hasPrompt || target.status !== 'eligible'}
          onSend={sendToAgentTarget}
        />
      ))}
      <DropdownMenuSeparator />
      <DropdownMenuLabel>
        {translate('auto.components.editor.ReviewNotesSendMenuContent.a49800405b', 'New agent')}
      </DropdownMenuLabel>
      <QuickLaunchAgentMenuItems
        worktreeId={worktreeId}
        groupId={groupId}
        onFocusTerminal={focusTerminalTabSurface}
        prompt={prompt}
        promptDelivery={promptDelivery}
        launchSource={launchSource}
        onPromptDelivered={onPromptDelivered}
      />
    </>
  )
}

function resolveCurrentSendTargetEligibility(
  target: NotesSendAgentTarget,
  worktreeId: string
): { status: 'eligible' } | { status: 'disabled'; disabledReason: string } {
  const currentTarget = deriveNotesSendAgentTargets(useAppStore.getState(), worktreeId).find(
    (candidate) => candidate.paneKey === target.paneKey
  )
  if (currentTarget) {
    return currentTarget.status === 'eligible'
      ? { status: 'eligible' }
      : {
          status: 'disabled',
          disabledReason: currentTarget.disabledReason ?? 'Terminal is no longer available'
        }
  }

  return { status: 'disabled', disabledReason: 'Terminal is no longer available' }
}

function AgentTargetMenuItem({
  target,
  agent,
  name,
  now,
  disabled,
  onSend
}: {
  target: NotesSendAgentTarget
  agent: DashboardAgentRowData | null
  name: string
  now: number
  disabled: boolean
  onSend: (target: NotesSendAgentTarget) => void
}): React.JSX.Element {
  const state = asDotState(agent?.state ?? 'idle')
  const timeAgo = agent ? formatAgentRelativeTime(agent, now) : null
  const agentLabel = formatAgentTypeLabel(target.agentType ?? agent?.agentType)
  // Why: the name is what the user picks between — several targets can share the
  // same harness — so it leads and the harness drops to the detail line. With no
  // name the harness label moves up rather than being repeated on both lines.
  const secondaryParts = [
    ...(name ? [agentLabel] : []),
    agentStateLabel(state),
    ...(timeAgo ? [timeAgo] : [])
  ]
  const disabledReason = target.status === 'disabled' ? target.disabledReason : undefined
  return (
    <DropdownMenuItem
      disabled={disabled}
      onSelect={() => onSend(target)}
      // Why: surface the ineligibility reason (permission/stale/no-terminal) as a
      // hover tooltip rather than inline text, matching DashboardAgentRow's
      // title-attribute treatment of the same disabledReason. The name can be a
      // live prompt, so it needs the same hover treatment once it is elided.
      title={disabledReason ?? (name || undefined)}
      className="min-w-[240px] gap-2 rounded-[7px] px-2 py-1.5 text-[12px] leading-5 font-medium"
    >
      <AgentStateDot state={state} size="sm" className="shrink-0" />
      <AgentIcon agent={agentTypeToIconAgent(target.agentType ?? agent?.agentType)} size={14} />
      {/* Why: the menu has no max width, so an unbounded name would widen the
          whole dropdown instead of eliding — bound it the way every other menu
          label does (TabBarQuickCommandsMenu, PRFilterDropdowns). */}
      <span className="grid max-w-[240px] min-w-0 flex-1 text-left">
        <span className="truncate" data-testid="send-target-name">
          {name || agentLabel}
        </span>
        <span
          className="truncate text-[11px] font-normal text-muted-foreground"
          data-testid="send-target-detail"
        >
          {secondaryParts.join(' · ')}
        </span>
      </span>
    </DropdownMenuItem>
  )
}

// Why: the row already carries the provider icon and harness name, so a title
// that only echoes identity or status is no name at all. Fall through to what
// the agent is working on — the same text the sidebar row shows for it — and
// then to the tab's stable ordinal so two unnamed idle tabs stay distinct.
function sendTargetName(
  target: NotesSendAgentTarget,
  agent: DashboardAgentRowData | null,
  agentType: AgentType | null | undefined,
  generatedTitlesEnabled: boolean
): string {
  const conversationName =
    agent && !agentRowOwnsTabName(agent)
      ? null
      : getAgentRowConversationName(target.tab, agentType, generatedTitlesEnabled)
  const named = agent ? agentRowPrimaryLabel(agent, conversationName) : (conversationName ?? '')
  return named.trim() || target.tab.defaultTitle?.trim() || ''
}

// Why: names resolve here, not in the derivation — this is the only place the
// agent type is reconciled against the row that renders, so a name resolved
// against a different harness than the row shows is impossible by construction.
function orderSendTargetsByWorktreeAgentRows(
  sendTargets: NotesSendAgentTarget[],
  agentRows: DashboardAgentRowData[],
  generatedTitlesEnabled: boolean
): OrderedSendTarget[] {
  const targetsByPaneKey = new Map(sendTargets.map((target) => [target.paneKey, target]))
  const usedPaneKeys = new Set<string>()
  const ordered: OrderedSendTarget[] = []

  for (const agent of agentRows) {
    const target = targetsByPaneKey.get(agent.paneKey)
    if (!target) {
      continue
    }
    const reconciled = { ...target, agentType: agent.agentType }
    ordered.push({
      target: reconciled,
      agent,
      name: sendTargetName(reconciled, agent, agent.agentType, generatedTitlesEnabled)
    })
    usedPaneKeys.add(target.paneKey)
  }

  for (const target of sendTargets) {
    if (!usedPaneKeys.has(target.paneKey)) {
      ordered.push({
        target,
        agent: null,
        name: sendTargetName(target, null, target.agentType, generatedTitlesEnabled)
      })
    }
  }

  return ordered
}

function asDotState(state: AgentStatusState | 'idle'): AgentDotState {
  switch (state) {
    case 'working':
    case 'blocked':
    case 'waiting':
    case 'done':
    case 'idle':
      return state
  }
  return 'idle'
}

function formatAgentRelativeTime(agent: DashboardAgentRowData, now: number): string | null {
  const doneAt = lastEnteredDoneAt(agent)
  if (doneAt !== null) {
    return `${formatTimeAgo(doneAt, now)}`
  }
  const startedAt = agent.startedAt > 0 ? agent.startedAt : agent.entry.stateStartedAt
  return startedAt > 0 ? `${formatTimeAgo(startedAt, now)}` : null
}

function lastEnteredDoneAt(agent: DashboardAgentRowData): number | null {
  const entry = agent.entry
  if (entry.state === 'done') {
    return entry.stateStartedAt
  }
  for (let i = entry.stateHistory.length - 1; i >= 0; i--) {
    if (entry.stateHistory[i].state === 'done') {
      return entry.stateHistory[i].startedAt
    }
  }
  return null
}

function formatTimeAgo(ts: number, now: number): string {
  const delta = now - ts
  if (delta < 60_000) {
    return 'just now'
  }
  const minutes = Math.floor(delta / 60_000)
  if (minutes < 60) {
    return `${minutes}m ago`
  }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    return `${hours}h ago`
  }
  return `${Math.floor(hours / 24)}d ago`
}
