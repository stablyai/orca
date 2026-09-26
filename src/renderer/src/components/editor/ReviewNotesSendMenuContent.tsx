import React, { useCallback, useMemo } from 'react'
import { toast } from 'sonner'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import { QuickLaunchAgentMenuItems } from '@/components/tab-bar/QuickLaunchButton'
import { DropdownMenuLabel, DropdownMenuSeparator } from '@/components/ui/dropdown-menu'
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
import { agentKindForAgentType } from '@/lib/agent-status'
import { track } from '@/lib/telemetry'
import { useNow } from '@/hooks/use-now'
import { selectLivePtyIdsForWorktree } from '@/components/sidebar/worktree-card-status-inputs'
import { useWorktreeAgentRows } from '@/components/sidebar/useWorktreeAgentRows'
import type { LaunchSource } from '../../../../shared/telemetry-events'
import { translate } from '@/i18n/i18n'
import {
  getTerminalIndexForTab,
  resolveCurrentSendTargetEligibility,
  orderSendTargetsByWorktreeAgentRows
} from './review-notes-send-menu-helpers'
import { AgentTargetMenuItem } from './AgentTargetMenuItem'

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
    () => orderSendTargetsByWorktreeAgentRows(sendTargets, agentRows),
    [agentRows, sendTargets]
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
              explicitTarget: options.explicitTarget,
              code: result.code
            })
          )
        })
        .catch(() => {
          console.error('Failed to send notes:', { code: 'runtime-unverifiable' })
          toast.error(
            activeAgentNotesSendFailureMessage('status-unavailable', {
              explicitTarget: options.explicitTarget,
              code: 'runtime-unverifiable'
            })
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
      {orderedSendTargets.map(({ target, agent }) => {
        const { terminalIndex, tabColor } = getTerminalIndexForTab(
          tabsByWorktree?.[worktreeId],
          target.tabId
        )
        return (
          <AgentTargetMenuItem
            key={target.paneKey}
            target={target}
            agent={agent}
            terminalIndex={terminalIndex}
            tabColor={tabColor}
            now={now}
            disabled={!hasPrompt || target.status !== 'eligible'}
            onSend={sendToAgentTarget}
          />
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
