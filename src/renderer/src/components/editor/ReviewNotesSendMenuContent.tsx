import React, { useCallback, useMemo } from 'react'
import { toast } from 'sonner'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import {
  useStructuredChatTabNames,
  getStructuredChatTabNames
} from '@/runtime/structured-chat-name-observation'
import { QuickLaunchAgentMenuItems } from '@/components/tab-bar/QuickLaunchButton'
import { AgentStateDot, agentStateLabel } from '@/components/AgentStateDot'
import { AgentTypeIcon } from '@/lib/agent-type-icon'
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator
} from '@/components/ui/dropdown-menu'
import { focusTerminalTabSurface } from '@/lib/focus-terminal-tab-surface'
import {
  activeAgentNotesSendFailureMessage,
  type ActiveAgentNotesSendResult
} from '@/lib/active-agent-note-send'
import { sendMessageToAgent } from '@/lib/agent-message-send'
import {
  deriveNotesSendAgentTargets,
  type NotesSendAgentTarget
} from '@/lib/notes-send-agent-targets'
import { agentKindForAgentType, formatAgentTypeLabel } from '@/lib/agent-status'
import { track } from '@/lib/telemetry'
import { useNow } from '@/hooks/use-now'
import type { DashboardAgentRow as DashboardAgentRowData } from '@/components/dashboard/useDashboardData'
import { lastEnteredDoneAt } from '@/components/dashboard/agent-finished-timestamp'
import { selectLivePtyIdsForWorktree } from '@/components/sidebar/worktree-card-status-inputs'
import { useWorktreeAgentRows } from '@/components/sidebar/useWorktreeAgentRows'
import { useAgentRowConversationName } from '@/components/dashboard/use-agent-row-conversation-name'
import { getAgentRowPrimaryText } from '../../../../shared/agent-row-primary-text'
import type { LaunchSource } from '../../../../shared/telemetry-events'
import { agentRowDisplayDotState } from '@/lib/agent-row-dot-state'
import { translate } from '@/i18n/i18n'
import { agentSendDisabledReasonLabel } from '@/lib/agent-send-disabled-reason-label'

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
  onPromptDelivered,
  onPromptHandedOff
}: {
  worktreeId: string
  groupId: string
  prompt: string
  promptDelivery?: 'auto-submit' | 'draft' | 'submit-after-ready'
  launchSource?: LaunchSource
  onPromptDelivered?: () => void
  /** Given each send's own result the moment its prompt is handed to an agent. */
  onPromptHandedOff?: (delivered: Promise<unknown>) => void
}): React.JSX.Element {
  const hasPrompt = prompt.trim().length > 0

  // Include every workspace agent, not just the focused pane; memoize slice-derived targets to avoid fresh selector arrays.
  const agentStatusByPaneKey = useAppStore((s) => s.agentStatusByPaneKey)
  const tabsByWorktree = useAppStore((s) => s.tabsByWorktree)
  const unifiedTabsByWorktree = useAppStore((s) => s.unifiedTabsByWorktree)
  const terminalLayoutsByTabId = useAppStore((s) => s.terminalLayoutsByTabId)
  const ptyIdsByTabId = useAppStore(useShallow((s) => selectLivePtyIdsForWorktree(s, worktreeId)))
  const runtimePaneTitlesByTabId = useAppStore((s) => s.runtimePaneTitlesByTabId)
  const agentStatusEpoch = useAppStore((s) => s.agentStatusEpoch)
  const agentRows = useWorktreeAgentRows(worktreeId)
  const now = useNow(30_000)
  const chatNames = useStructuredChatTabNames()
  const sendTargets = useMemo(() => {
    void agentStatusEpoch
    return deriveNotesSendAgentTargets(
      {
        agentStatusByPaneKey,
        tabsByWorktree,
        unifiedTabsByWorktree,
        terminalLayoutsByTabId,
        ptyIdsByTabId,
        runtimePaneTitlesByTabId
      },
      worktreeId,
      chatNames
    )
  }, [
    // Freshness timers can change eligibility through this epoch without replacing the status map.
    agentStatusEpoch,
    chatNames,
    agentStatusByPaneKey,
    tabsByWorktree,
    unifiedTabsByWorktree,
    terminalLayoutsByTabId,
    runtimePaneTitlesByTabId,
    ptyIdsByTabId,
    worktreeId
  ])
  const orderedSendTargets = useMemo(
    () => orderSendTargetsByWorktreeAgentRows(sendTargets, agentRows),
    [agentRows, sendTargets]
  )

  const runNotesSend = useCallback(
    (
      send: () => Promise<ActiveAgentNotesSendResult>,
      onSent: () => void,
      options: { explicitTarget?: boolean } = {}
    ) => {
      // Settle the loading toast in place: immediate sends can resolve before Sonner mounts, racing a separate dismissal.
      const pending = toast.loading(
        translate(
          'auto.components.editor.ReviewNotesSendMenuContent.50f7e753ea',
          'Sending notes...'
        )
      )

      const sending = send()
        .then((result) => {
          if (result.status === 'sent') {
            onSent()
            toast.success(
              translate(
                'auto.components.editor.ReviewNotesSendMenuContent.bb9c69a0c9',
                'Notes sent.'
              ),
              { id: pending }
            )
            return
          }

          // Use a typed toast update; toast.message preserves the loading spinner.
          toast.info(
            activeAgentNotesSendFailureMessage(result.status, {
              explicitTarget: options.explicitTarget,
              code: result.code
            }),
            { id: pending }
          )
        })
        .catch(() => {
          console.error('Failed to send notes:', { code: 'runtime-unverifiable' })
          toast.error(
            activeAgentNotesSendFailureMessage('status-unavailable', {
              explicitTarget: options.explicitTarget,
              code: 'runtime-unverifiable'
            }),
            { id: pending }
          )
        })
      onPromptHandedOff?.(sending)
    },
    [onPromptHandedOff]
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
        () => sendMessageToAgent({ worktreeId, prompt, target: target.messageTarget }),
        () => {
          onPromptDelivered?.()
          // Match sidebar telemetry for follow-up notes sent through the dropdown.
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
      {orderedSendTargets.map(({ target, agent }) => {
        const itemProps = {
          target,
          now,
          disabled: !hasPrompt || target.status !== 'eligible',
          onSend: sendToAgentTarget
        }
        return agent ? (
          <AgentRowTargetMenuItem key={target.paneKey} {...itemProps} agent={agent} />
        ) : (
          <AgentTargetMenuItem key={target.paneKey} {...itemProps} agent={null} name="" />
        )
      })}
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
        onPromptHandedOff={onPromptHandedOff}
        disabled={!hasPrompt}
      />
    </>
  )
}

function resolveCurrentSendTargetEligibility(
  target: NotesSendAgentTarget,
  worktreeId: string
): { status: 'eligible' } | { status: 'disabled'; disabledReason: string } {
  const goneReason =
    target.messageTarget.kind === 'terminal'
      ? translate(
          'auto.components.editor.ReviewNotesSendMenu.terminalGone',
          'Terminal is no longer available'
        )
      : translate('auto.components.editor.ReviewNotesSendMenu.chatGone', 'Chat is no longer open')
  const state = useAppStore.getState()
  const currentTarget = deriveNotesSendAgentTargets(
    state,
    worktreeId,
    getStructuredChatTabNames()
  ).find((candidate) => candidate.paneKey === target.paneKey)
  if (currentTarget) {
    return currentTarget.status === 'eligible'
      ? { status: 'eligible' }
      : {
          status: 'disabled',
          disabledReason: currentTarget.disabledReason
            ? agentSendDisabledReasonLabel(currentTarget.disabledReason)
            : goneReason
        }
  }

  return { status: 'disabled', disabledReason: goneReason }
}

type AgentTargetMenuItemProps = {
  target: NotesSendAgentTarget
  agent: DashboardAgentRowData | null
  now: number
  disabled: boolean
  onSend: (target: NotesSendAgentTarget) => void
}

function AgentRowTargetMenuItem(
  props: AgentTargetMenuItemProps & { agent: DashboardAgentRowData }
): React.JSX.Element {
  const conversationName = useAgentRowConversationName(props.agent)
  // Same name as the agent's sidebar row, so same-type agents stay distinguishable.
  const name = conversationName ?? getAgentRowPrimaryText(props.agent.entry)
  return <AgentTargetMenuItem {...props} name={name} />
}

function AgentTargetMenuItem({
  target,
  agent,
  name,
  now,
  disabled,
  onSend
}: AgentTargetMenuItemProps & { name: string }): React.JSX.Element {
  const tabTitle = target.tabTitle.trim()
  const typeLabel = formatAgentTypeLabel(target.agentType ?? agent?.agentType)
  // Use the sidebar’s display state so failed/stopped agents agree across surfaces.
  const state = agent ? agentRowDisplayDotState(agent) : 'idle'
  const timeAgo = agent ? formatAgentRelativeTime(agent, now) : null
  const disabledReason =
    target.status === 'disabled' && target.disabledReason
      ? agentSendDisabledReasonLabel(target.disabledReason)
      : undefined
  const secondaryParts = [
    ...(name ? [typeLabel] : []),
    agentStateLabel(state),
    ...(timeAgo ? [timeAgo] : []),
    // Why: unnamed rows keep the raw tab title as their only differentiator.
    ...(!name && tabTitle ? [tabTitle] : [])
  ]
  return (
    <DropdownMenuItem
      disabled={disabled}
      onSelect={() => onSend(target)}
      // Match dashboard tooltips for disabled reasons; otherwise show the full, possibly truncated, name.
      title={disabledReason ?? (name || undefined)}
      className="min-w-[240px] gap-2 rounded-[7px] px-2 py-1.5 text-[12px] leading-5 font-medium"
    >
      {/* Why: the ancestor's actionable disabled reason must win on every hit area. */}
      <AgentStateDot
        state={state}
        size="sm"
        className="shrink-0"
        title={disabledReason ? null : undefined}
      />
      <AgentTypeIcon agentType={target.agentType ?? agent?.agentType} size={14} />
      <span className="grid max-w-[300px] min-w-0 flex-1 text-left">
        <span className="truncate">{name || typeLabel}</span>
        <span className="truncate text-[11px] font-normal text-muted-foreground">
          {secondaryParts.join(' · ')}
        </span>
      </span>
    </DropdownMenuItem>
  )
}

function orderSendTargetsByWorktreeAgentRows(
  sendTargets: NotesSendAgentTarget[],
  agentRows: DashboardAgentRowData[]
): OrderedSendTarget[] {
  const targetsByPaneKey = new Map(sendTargets.map((target) => [target.paneKey, target]))
  const usedPaneKeys = new Set<string>()
  const ordered: OrderedSendTarget[] = []

  for (const agent of agentRows) {
    const target = targetsByPaneKey.get(agent.paneKey)
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

function formatAgentRelativeTime(agent: DashboardAgentRowData, now: number): string | null {
  const doneAt = lastEnteredDoneAt(agent)
  if (doneAt !== null) {
    return `${formatTimeAgo(doneAt, now)}`
  }
  const startedAt = agent.startedAt > 0 ? agent.startedAt : agent.entry.stateStartedAt
  return startedAt > 0 ? `${formatTimeAgo(startedAt, now)}` : null
}

function formatTimeAgo(ts: number, now: number): string {
  const delta = now - ts
  if (delta < 60_000) {
    return translate('auto.components.editor.ReviewNotesSendMenu.justNow', 'just now')
  }
  const minutes = Math.floor(delta / 60_000)
  if (minutes < 60) {
    return translate('auto.components.editor.ReviewNotesSendMenu.minutesAgo', '{{minutes}}m ago', {
      minutes
    })
  }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    return translate('auto.components.editor.ReviewNotesSendMenu.hoursAgo', '{{hours}}h ago', {
      hours
    })
  }
  return translate('auto.components.editor.ReviewNotesSendMenu.daysAgo', '{{days}}d ago', {
    days: Math.floor(hours / 24)
  })
}
