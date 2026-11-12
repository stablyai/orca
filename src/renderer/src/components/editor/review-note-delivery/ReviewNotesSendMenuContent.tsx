import {
  useAppStateValue,
  useAppStateView,
  useAppStateViewActive
} from '@/store/retained-views/app-state-view'
import { toast } from 'sonner'
import { shallow } from 'zustand/shallow'
import { useShallow } from 'zustand/react/shallow'
import {
  selectLiveAgentStatusEntriesForWorktree,
  selectTerminalLayoutsForWorktree
} from '@/components/sidebar/workspace-card/activity/worktree-agent-row-selectors'
import {
  selectRuntimePaneTitlesForWorktree,
  selectLivePtyIdsForWorktree
} from '@/components/sidebar/workspace-card/activity/worktree-card-status-inputs'
import { useAppStore } from '@/store/index'
import { selectKnownWorktreeById } from '@/store/workspaces/selection/known-worktree-selection'
import {
  useWorktreeStructuredChatTabNames,
  getStructuredChatTabNames
} from '@/runtime/native-chat/naming/structured-chat-name-observation'
import { QuickLaunchAgentMenuItems } from '@/components/tab-bar/QuickLaunchButton'
import { AgentStateDot, agentStateLabel } from '@/components/AgentStateDot'
import { AgentTypeIcon } from '@/components/agent/icons/agent-type-icon'
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator
} from '@/components/ui/dropdown-menu'
import { focusTerminalTabSurface } from '@/components/terminal-pane/input/focus/focus-terminal-tab-surface'
import '@/lib/agent-session/messaging/terminal/active-agent-note-send'
import {
  activeAgentNotesSendFailureMessage,
  type ActiveAgentNotesSendResult
} from '@/lib/agent-session/messaging/terminal/active-agent-note-send-result'
import { sendMessageToAgent } from '@/lib/agent-session/messaging/agent-message-send'
import {
  deriveNotesSendAgentTargets,
  type NotesSendAgentTarget
} from '@/lib/agent-session/messaging/notes-send-agent-targets'
import { agentKindForAgentType } from '@/lib/agent-status/aggregation/worktree-agent-status'
import { formatAgentTypeLabel } from '../../../../../shared/agent-status/presentation/agent-type-label'
import { track } from '@/diagnostics/telemetry/telemetry'
import { useNow } from '@/hooks/use-now'
import type { DashboardAgentRow as DashboardAgentRowData } from '@/components/dashboard/useDashboardData'
import { lastEnteredDoneAt } from '@/components/dashboard/agent-finished-timestamp'
import { useWorktreeAgentRows } from '@/components/sidebar/workspace-card/activity/useWorktreeAgentRows'
import { useAgentRowConversationName } from '@/components/dashboard/use-agent-row-conversation-name'
import { getAgentRowPrimaryText } from '../../../../../shared/agent-status/presentation/agent-row-primary-text'
import type { LaunchSource } from '../../../../../shared/telemetry-property-schemas'
import { agentRowDisplayDotState } from '@/lib/agent-status/presentation/agent-row-dot-state'
import { translate } from '@/i18n/i18n'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { agentSendDisabledReasonLabel } from '@/lib/agent-session/messaging/agent-send-disabled-reason-label'
import { addQuoteToAgent } from '@/components/native-chat/selection-quotes/native-chat-workspace-selection'
import React, { useCallback, useMemo } from 'react'
import { orderSendTargetsByWorktreeAgentRows } from './review-notes-send-target-order'

export function ReviewNotesSendMenuContent({
  worktreeId,
  groupId,
  prompt,
  promptDelivery = 'submit-after-ready',
  launchSource = 'notes_send',
  onPromptDelivered,
  onPromptHandedOff,
  mode = 'send'
}: {
  worktreeId: string
  groupId: string
  prompt: string
  /** 'add-to-chat' puts the prompt where the picked or new agent takes input, never sending it. */
  mode?: 'send' | 'add-to-chat'
  promptDelivery?: 'auto-submit' | 'draft' | 'submit-after-ready'
  launchSource?: LaunchSource
  onPromptDelivered?: () => void
  /** Given each send's own result the moment its prompt is handed to an agent. */
  onPromptHandedOff?: (delivered: Promise<unknown>) => void
}): React.JSX.Element {
  const t = useTranslate()
  const hasPrompt = prompt.trim().length > 0

  const viewActive = useAppStateViewActive()
  const store = useAppStateView()
  const agentRows = useWorktreeAgentRows(worktreeId)
  const now = useNow(30_000, viewActive)
  const worktree = useAppStateValue(
    useShallow((state) => {
      const row = selectKnownWorktreeById(state, worktreeId)
      return row
        ? {
            id: row.id,
            hostId: row.hostId,
            runtimeOwnerEnvironmentId: row.runtimeOwnerEnvironmentId
          }
        : null
    })
  )
  const tabsKey = useAppStateValue((state) => state.unifiedTabsByWorktree[worktreeId])
  const chatNames = useWorktreeStructuredChatTabNames(worktree, tabsKey, true)
  const selectTargets = useMemo(() => {
    let inputs: unknown[] = []
    let previous: NotesSendAgentTarget[] = []
    return (state: ReturnType<typeof store.getState>) => {
      const nextInputs = [
        state.tabsByWorktree[worktreeId],
        state.unifiedTabsByWorktree[worktreeId],
        selectLiveAgentStatusEntriesForWorktree(state, worktreeId),
        selectTerminalLayoutsForWorktree(state, worktreeId),
        selectLivePtyIdsForWorktree(state, worktreeId),
        selectRuntimePaneTitlesForWorktree(state, worktreeId),
        state.agentStatusEpoch
      ]
      if (shallow(inputs, nextInputs)) {
        return previous
      }
      inputs = nextInputs
      const next = deriveNotesSendAgentTargets(state, worktreeId, chatNames)
      if (
        next.length !== previous.length ||
        next.some((target, i) => !shallow(target, previous[i]))
      ) {
        previous = next
      }
      return previous
    }
  }, [worktreeId, chatNames])
  const sendTargets = useAppStateValue(selectTargets)
  const orderedSendTargets = useMemo(
    () => orderSendTargetsByWorktreeAgentRows(sendTargets, agentRows),
    [agentRows, sendTargets]
  )

  const runNotesSend = useCallback(
    (
      send: () => Promise<ActiveAgentNotesSendResult>,
      onSent: () => void,
      options: { explicitTarget?: boolean; structured?: boolean } = {}
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

          if (options.structured && result.status === 'unconfirmed') {
            toast.dismiss(pending)
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
      if (mode === 'add-to-chat') {
        void addQuoteToAgent(worktreeId, target.messageTarget, prompt).then((result) => {
          if (result.status !== 'sent') {
            toast.info(
              activeAgentNotesSendFailureMessage(result.status, {
                explicitTarget: true,
                subject: 'selection'
              })
            )
          }
        })
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
        { explicitTarget: true, structured: target.messageTarget.kind === 'structured-session' }
      )
    },
    [hasPrompt, mode, runNotesSend, worktreeId, prompt, onPromptDelivered, launchSource]
  )

  return (
    <>
      <DropdownMenuLabel>
        {mode === 'add-to-chat'
          ? t('components.native-chat.addSelectionToChat', 'Add to chat')
          : t('auto.components.editor.ReviewNotesSendMenuContent.03378aea75', 'Send notes to')}
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
        {t('auto.components.editor.ReviewNotesSendMenuContent.a49800405b', 'New agent')}
      </DropdownMenuLabel>
      <QuickLaunchAgentMenuItems
        worktreeId={worktreeId}
        groupId={groupId}
        onFocusTerminal={focusTerminalTabSurface}
        prompt={prompt}
        promptDelivery={mode === 'add-to-chat' ? 'draft' : promptDelivery}
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
  const t = useTranslate()
  const tabTitle = target.tabTitle.trim()
  const typeLabel = formatAgentTypeLabel(target.agentType ?? agent?.agentType)
  // Use the sidebar’s display state so failed/stopped agents agree across surfaces.
  const state = agent ? agentRowDisplayDotState(agent) : 'idle'
  const timeAgo = agent ? formatAgentRelativeTime(agent, now, t) : null
  const disabledReason =
    target.status === 'disabled' && target.disabledReason
      ? agentSendDisabledReasonLabel(target.disabledReason, t)
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

function formatAgentRelativeTime(
  agent: DashboardAgentRowData,
  now: number,
  t?: Translate
): string | null {
  const doneAt = lastEnteredDoneAt(agent)
  if (doneAt !== null) {
    return `${formatTimeAgo(doneAt, now, t)}`
  }
  const startedAt = agent.startedAt > 0 ? agent.startedAt : agent.entry.stateStartedAt
  return startedAt > 0 ? `${formatTimeAgo(startedAt, now, t)}` : null
}

function formatTimeAgo(ts: number, now: number, t: Translate = translate): string {
  const delta = now - ts
  if (delta < 60_000) {
    return t('auto.components.editor.ReviewNotesSendMenu.justNow', 'just now')
  }
  const minutes = Math.floor(delta / 60_000)
  if (minutes < 60) {
    return t('auto.components.editor.ReviewNotesSendMenu.minutesAgo', '{{minutes}}m ago', {
      minutes
    })
  }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    return t('auto.components.editor.ReviewNotesSendMenu.hoursAgo', '{{hours}}h ago', {
      hours
    })
  }
  return t('auto.components.editor.ReviewNotesSendMenu.daysAgo', '{{days}}d ago', {
    days: Math.floor(hours / 24)
  })
}
