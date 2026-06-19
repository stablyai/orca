import React, { useCallback, useMemo } from 'react'
import { toast } from 'sonner'
import { useShallow } from 'zustand/react/shallow'
import { AgentStateDot, agentStateLabel } from '@/components/AgentStateDot'
import { useNow } from '@/components/dashboard/useNow'
import type { DashboardAgentRow as DashboardAgentRowData } from '@/components/dashboard/useDashboardData'
import { useWorktreeAgentRows } from '@/components/sidebar/useWorktreeAgentRows'
import { QuickLaunchAgentMenuItems } from '@/components/tab-bar/QuickLaunchButton'
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator
} from '@/components/ui/dropdown-menu'
import {
  activeAgentNotesSendFailureMessage,
  sendNotesToActiveAgentSession
} from '@/lib/active-agent-note-send'
import { AgentIcon } from '@/lib/agent-catalog'
import {
  agentKindForAgentType,
  agentTypeToIconAgent,
  formatAgentTypeLabel
} from '@/lib/agent-status'
import { focusTerminalTabSurface } from '@/lib/focus-terminal-tab-surface'
import { deriveNotesSendAgentTargets } from '@/lib/notes-send-agent-targets'
import { track } from '@/lib/telemetry'
import { useAppStore } from '@/store'
import type { AgentStatusState, AgentType } from '../../../../shared/agent-status-types'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import type { LaunchSource } from '../../../../shared/telemetry-events'
import { translate } from '@/i18n/i18n'

type NotesSendState = ReturnType<typeof selectNotesSendState>

type ReviewNotesTarget = {
  paneKey: string
  tabId: string
  leafId: string
  agentType: AgentType | null | undefined
  title: string
  status: 'eligible' | 'disabled'
  disabledReason?: string
  state?: AgentStatusState | 'idle'
  startedAt?: number
}

function selectNotesSendState(state: ReturnType<typeof useAppStore.getState>) {
  return {
    agentStatusByPaneKey: state.agentStatusByPaneKey,
    agentStatusEpoch: state.agentStatusEpoch,
    tabsByWorktree: state.tabsByWorktree,
    terminalLayoutsByTabId: state.terminalLayoutsByTabId,
    ptyIdsByTabId: state.ptyIdsByTabId,
    runtimePaneTitlesByTabId: state.runtimePaneTitlesByTabId
  }
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

function isPaneLive(state: NotesSendState, tabId: string, leafId: string): boolean {
  const layoutPtyId = state.terminalLayoutsByTabId[tabId]?.ptyIdsByLeafId?.[leafId] ?? null
  if (!layoutPtyId) {
    return false
  }
  const tabPtyIds = state.ptyIdsByTabId?.[tabId]
  return tabPtyIds === undefined || tabPtyIds.includes(layoutPtyId)
}

function targetFromAgentRow(
  row: DashboardAgentRowData,
  state: NotesSendState
): ReviewNotesTarget | null {
  const parsed = parsePaneKey(row.paneKey)
  if (!parsed || !isPaneLive(state, parsed.tabId, parsed.leafId)) {
    return null
  }
  return {
    paneKey: row.paneKey,
    tabId: parsed.tabId,
    leafId: parsed.leafId,
    agentType: row.agentType,
    title: row.tab.title,
    status: 'eligible',
    state: row.state,
    startedAt: row.startedAt
  }
}

function buildReviewNotesTargets(
  derivedTargets: ReturnType<typeof deriveNotesSendAgentTargets>,
  agentRows: DashboardAgentRowData[],
  state: NotesSendState
): ReviewNotesTarget[] {
  const derivedByPaneKey = new Map(derivedTargets.map((target) => [target.paneKey, target]))
  const emittedPaneKeys = new Set<string>()
  const ordered: ReviewNotesTarget[] = []

  for (const row of agentRows) {
    const derived = derivedByPaneKey.get(row.paneKey)
    const rowTarget = targetFromAgentRow(row, state)
    if (!derived && !rowTarget) {
      continue
    }
    const target: ReviewNotesTarget | null = derived
      ? {
          paneKey: derived.paneKey,
          tabId: derived.tabId,
          leafId: derived.leafId,
          agentType: derived.agentType,
          title: row.tab.title,
          status: derived.status,
          ...(derived.disabledReason ? { disabledReason: derived.disabledReason } : {}),
          state: row.state,
          startedAt: row.startedAt
        }
      : rowTarget
    if (!target) {
      continue
    }
    ordered.push(target)
    emittedPaneKeys.add(target.paneKey)
  }

  for (const target of derivedTargets) {
    if (emittedPaneKeys.has(target.paneKey)) {
      continue
    }
    ordered.push({
      paneKey: target.paneKey,
      tabId: target.tabId,
      leafId: target.leafId,
      agentType: target.agentType,
      title: target.tabTitle,
      status: target.status,
      ...(target.disabledReason ? { disabledReason: target.disabledReason } : {})
    })
  }

  return ordered
}

function targetStatusText(target: ReviewNotesTarget, now: number): string | null {
  if (!target.state || target.startedAt == null) {
    return null
  }
  return `${agentStateLabel(target.state)} · ${formatTimeAgo(target.startedAt, now)}`
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
  const now = useNow(30_000)
  const state = useAppStore(useShallow(selectNotesSendState))
  const agentRows = useWorktreeAgentRows(worktreeId)
  const targets = useMemo(() => {
    const derivedTargets = deriveNotesSendAgentTargets(state, worktreeId, now)
    return buildReviewNotesTargets(derivedTargets, agentRows, state)
  }, [agentRows, now, state, worktreeId])

  const sendToTarget = useCallback(
    (target: ReviewNotesTarget) => {
      if (!hasPrompt || target.status === 'disabled') {
        return
      }
      const pending = toast.loading(
        translate(
          'auto.components.editor.ReviewNotesSendMenuContent.50f7e753ea',
          'Sending notes to active agent...'
        )
      )
      void sendNotesToActiveAgentSession({
        worktreeId,
        prompt,
        noteTarget: { tabId: target.tabId, leafId: target.leafId }
      })
        .then((result) => {
          if (result.status === 'sent') {
            onPromptDelivered?.()
            track('agent_prompt_sent', {
              agent_kind: agentKindForAgentType(target.agentType),
              launch_source: launchSource,
              request_kind: 'followup'
            })
            toast.success(
              translate(
                'auto.components.editor.ReviewNotesSendMenuContent.bb9c69a0c9',
                'Notes sent to active agent.'
              )
            )
            return
          }
          toast.message(activeAgentNotesSendFailureMessage(result.status))
        })
        .catch((error) => {
          console.error('Failed to send notes to active agent:', error)
          toast.error(
            translate(
              'auto.components.editor.ReviewNotesSendMenuContent.f5096c6e4e',
              'Could not send notes to the active agent.'
            )
          )
        })
        .finally(() => {
          toast.dismiss(pending)
        })
    },
    [hasPrompt, launchSource, onPromptDelivered, prompt, worktreeId]
  )

  return (
    <>
      <DropdownMenuLabel>
        {translate('auto.components.editor.ReviewNotesSendMenuContent.03378aea75', 'Send notes to')}
      </DropdownMenuLabel>
      {targets.map((target) => {
        const statusText = targetStatusText(target, now)
        return (
          <DropdownMenuItem
            key={target.paneKey}
            disabled={!hasPrompt || target.status === 'disabled'}
            title={target.disabledReason}
            onSelect={() => sendToTarget(target)}
            className="gap-2 rounded-[7px] px-2 py-1.5 text-[12px] leading-5 font-medium"
          >
            <AgentIcon agent={agentTypeToIconAgent(target.agentType)} size={14} />
            <span className="min-w-0 flex-1 truncate">
              {formatAgentTypeLabel(target.agentType)}
              {target.title ? ` · ${target.title}` : ''}
            </span>
            {target.state && <AgentStateDot state={target.state} />}
            {statusText && <span className="text-muted-foreground">{statusText}</span>}
          </DropdownMenuItem>
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
      />
    </>
  )
}
