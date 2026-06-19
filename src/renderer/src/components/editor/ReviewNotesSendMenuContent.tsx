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
import { agentKindForAgentType, formatAgentTypeLabel } from '@/lib/agent-status'
import { agentTypeToIconAgent } from '@/lib/agent-status'
import { track } from '@/lib/telemetry'
import { useNow } from '@/components/dashboard/useNow'
import type { DashboardAgentRow as DashboardAgentRowData } from '@/components/dashboard/useDashboardData'
import { selectLivePtyIdsForWorktree } from '@/components/sidebar/worktree-card-status-inputs'
import { useWorktreeAgentRows } from '@/components/sidebar/useWorktreeAgentRows'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import type { LaunchSource } from '../../../../shared/telemetry-events'
import type { AgentStatusState } from '../../../../shared/agent-status-types'
import { translate } from '@/i18n/i18n'

type OrderedSendTarget = {
  target: NotesSendAgentTarget
  agent: DashboardAgentRowData | null
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
    () =>
      orderSendTargetsByWorktreeAgentRows(
        sendTargets,
        agentRows,
        terminalLayoutsByTabId,
        ptyIdsByTabId
      ),
    [agentRows, sendTargets, terminalLayoutsByTabId, ptyIdsByTabId]
  )

  const runNotesSend = useCallback(
    (send: () => Promise<ActiveAgentNotesSendResult>, onSent: () => void) => {
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

          toast.message(activeAgentNotesSendFailureMessage(result.status))
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
        }
      )
    },
    [hasPrompt, runNotesSend, worktreeId, prompt, onPromptDelivered, launchSource]
  )

  return (
    <>
      <DropdownMenuLabel>
        {translate('auto.components.editor.ReviewNotesSendMenuContent.03378aea75', 'Send notes to')}
      </DropdownMenuLabel>
      {orderedSendTargets.map(({ target, agent }) => (
        <AgentTargetMenuItem
          key={target.paneKey}
          target={target}
          agent={agent}
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

function AgentTargetMenuItem({
  target,
  agent,
  now,
  disabled,
  onSend
}: {
  target: NotesSendAgentTarget
  agent: DashboardAgentRowData | null
  now: number
  disabled: boolean
  onSend: (target: NotesSendAgentTarget) => void
}): React.JSX.Element {
  const tabTitle = target.tabTitle.trim()
  const state = asDotState(agent?.state ?? 'idle')
  const timeAgo = agent ? formatAgentRelativeTime(agent, now) : null
  const secondaryParts = [
    agentStateLabel(state),
    ...(timeAgo ? [timeAgo] : []),
    ...(tabTitle ? [tabTitle] : [])
  ]
  return (
    <DropdownMenuItem
      disabled={disabled}
      onSelect={() => onSend(target)}
      // Why: surface the ineligibility reason (working/stale/no-terminal) as a
      // hover tooltip rather than inline text, matching DashboardAgentRow's
      // title-attribute treatment of the same disabledReason.
      title={target.status === 'disabled' ? target.disabledReason : undefined}
      className="min-w-[240px] gap-2 rounded-[7px] px-2 py-1.5 text-[12px] leading-5 font-medium"
    >
      <AgentStateDot state={state} size="sm" className="shrink-0" />
      <AgentIcon agent={agentTypeToIconAgent(target.agentType ?? agent?.agentType)} size={14} />
      <span className="grid min-w-0 flex-1 text-left">
        <span className="truncate">
          {formatAgentTypeLabel(target.agentType ?? agent?.agentType)}
        </span>
        <span className="truncate text-[11px] font-normal text-muted-foreground">
          {secondaryParts.join(' · ')}
        </span>
      </span>
    </DropdownMenuItem>
  )
}

function orderSendTargetsByWorktreeAgentRows(
  sendTargets: NotesSendAgentTarget[],
  agentRows: DashboardAgentRowData[],
  terminalLayoutsByTabId: Record<string, { ptyIdsByLeafId?: Record<string, string> } | undefined>,
  ptyIdsByTabId: Record<string, string[]>
): OrderedSendTarget[] {
  const targetsByPaneKey = new Map(sendTargets.map((target) => [target.paneKey, target]))
  const usedPaneKeys = new Set<string>()
  const ordered: OrderedSendTarget[] = []

  for (const agent of agentRows) {
    const target =
      targetsByPaneKey.get(agent.paneKey) ??
      deriveTitleOnlySendTarget(agent, terminalLayoutsByTabId, ptyIdsByTabId)
    if (!target) {
      continue
    }
    ordered.push({ target: { ...target, agentType: agent.agentType }, agent })
    usedPaneKeys.add(target.paneKey)
  }

  for (const target of sendTargets) {
    if (!usedPaneKeys.has(target.paneKey)) {
      ordered.push({ target, agent: null })
    }
  }

  return ordered
}

function deriveTitleOnlySendTarget(
  agent: DashboardAgentRowData,
  terminalLayoutsByTabId: Record<string, { ptyIdsByLeafId?: Record<string, string> } | undefined>,
  ptyIdsByTabId: Record<string, string[]>
): NotesSendAgentTarget | null {
  const parsed = parsePaneKey(agent.paneKey)
  if (!parsed) {
    return null
  }
  const ptyId = terminalLayoutsByTabId[parsed.tabId]?.ptyIdsByLeafId?.[parsed.leafId] ?? null
  if (!ptyId || !ptyIdsByTabId[parsed.tabId]?.includes(ptyId)) {
    return null
  }
  const disabledReason = agent.state === 'working' ? 'Agent is working' : undefined
  return {
    paneKey: agent.paneKey,
    tabId: parsed.tabId,
    leafId: parsed.leafId,
    agentType: agent.agentType,
    tabTitle: agent.tab.title,
    status: disabledReason ? 'disabled' : 'eligible',
    ...(disabledReason ? { disabledReason } : {})
  }
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
