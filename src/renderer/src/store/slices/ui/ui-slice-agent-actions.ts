import type { UISlice, UISliceGet, UISliceSet } from './ui-slice-contract'
import { formatAgentTypeLabel, agentKindForAgentType } from '../../../lib/agent-status'
import {
  deriveRunningAgentSendTargets,
  resolveRunningAgentSendTarget
} from '../../../lib/running-agent-targets'
import { translate } from '@/i18n/i18n'
import { createUiActivityActions } from './ui-slice-activity-actions'

let agentSendTargetModeInstanceCounter = 0

function createAgentSendTargetModeInstanceId(): string {
  agentSendTargetModeInstanceCounter += 1
  return `${Date.now()}:${agentSendTargetModeInstanceCounter}`
}

export function createUiAgentActions(
  set: UISliceSet,
  get: UISliceGet
): Pick<
  UISlice,
  | 'sidebarOpen'
  | 'sidebarWidth'
  | 'toggleSidebar'
  | 'setSidebarOpen'
  | 'setSidebarWidth'
  | 'agentSendPopoverTargetMode'
  | 'openAgentSendPopoverTargetMode'
  | 'closeAgentSendPopoverTargetMode'
  | 'sendPromptToSidebarAgentTarget'
  | 'diffNotesSendMenuOpenRequest'
  | 'openDiffNotesSendMenuForActiveWorktree'
  | 'consumeDiffNotesSendMenuOpenRequest'
  | 'acknowledgedAgentsByPaneKey'
  | 'acknowledgeAgents'
  | 'unacknowledgeAgents'
  | 'activityClearedAtByPaneKey'
  | 'applyActivityClearedAt'
  | 'manuallyUnreadTurnsByPaneKey'
  | 'clearManuallyUnreadTurns'
> {
  return {
    ...createUiActivityActions(set, get),
    sidebarOpen: true,
    sidebarWidth: 280,
    toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
    setSidebarOpen: (open) => set({ sidebarOpen: open }),
    setSidebarWidth: (width) => set({ sidebarWidth: width }),
    agentSendPopoverTargetMode: null,
    openAgentSendPopoverTargetMode: (args) => {
      const targets = deriveRunningAgentSendTargets(get(), args.worktreeId)
      const previousMode = get().agentSendPopoverTargetMode
      if (previousMode?.id === args.id && previousMode.status === 'sending') {
        return
      }
      const disabledPaneKeys: Record<string, string> = {}
      for (const target of targets) {
        if (target.status === 'disabled' && target.disabledReason) {
          disabledPaneKeys[target.paneKey] = target.disabledReason
        }
      }
      set({
        agentSendPopoverTargetMode: {
          ...args,
          instanceId: createAgentSendTargetModeInstanceId(),
          eligiblePaneKeys: targets
            .filter((target) => target.status === 'eligible')
            .map((target) => target.paneKey),
          disabledPaneKeys,
          status: 'open'
        }
      })
      if (
        targets.some((target) => target.status === 'eligible') &&
        (previousMode?.id !== args.id || previousMode.worktreeId !== args.worktreeId)
      ) {
        get().revealWorktreeInSidebar(args.worktreeId, { behavior: 'auto', highlight: true })
      }
    },
    diffNotesSendMenuOpenRequest: null,
    openDiffNotesSendMenuForActiveWorktree: () => {
      const worktreeId = get().activeWorktreeId
      if (!worktreeId) {
        return false
      }
      // Why: no unsent notes means nothing to send, so don't hijack focus or reveal the panel.
      if (
        !get()
          .getDiffComments(worktreeId)
          .some((comment) => !comment.sentAt)
      ) {
        return false
      }
      get().setRightSidebarTab('source-control')
      get().setRightSidebarOpen(true)
      const nonce = (get().diffNotesSendMenuOpenRequest?.nonce ?? 0) + 1
      set({ diffNotesSendMenuOpenRequest: { worktreeId, nonce, issuedAt: Date.now() } })
      return true
    },
    consumeDiffNotesSendMenuOpenRequest: (worktreeId) =>
      set((s) =>
        s.diffNotesSendMenuOpenRequest?.worktreeId === worktreeId
          ? { diffNotesSendMenuOpenRequest: null }
          : s
      ),
    closeAgentSendPopoverTargetMode: (id, instanceId) =>
      set((s) => {
        if (!s.agentSendPopoverTargetMode) {
          return s
        }
        if (id && s.agentSendPopoverTargetMode.id !== id) {
          return s
        }
        if (instanceId && s.agentSendPopoverTargetMode.instanceId !== instanceId) {
          return s
        }
        return { agentSendPopoverTargetMode: null }
      }),
    sendPromptToSidebarAgentTarget: async (paneKey) => {
      const mode = get().agentSendPopoverTargetMode
      if (!mode || mode.status === 'sending') {
        return false
      }

      const target = resolveRunningAgentSendTarget(get(), mode.worktreeId, paneKey)
      if (!target || target.status !== 'eligible' || !target.ptyId) {
        // Why: eligibility can drop after the menu opened; keep the picker open (row title explains) rather than adding toast noise.
        return false
      }

      set((s) =>
        s.agentSendPopoverTargetMode?.id === mode.id &&
        s.agentSendPopoverTargetMode.instanceId === mode.instanceId
          ? {
              agentSendPopoverTargetMode: {
                ...s.agentSendPopoverTargetMode,
                status: 'sending',
                sendingPaneKey: paneKey,
                error: undefined
              }
            }
          : s
      )

      const label = formatAgentTypeLabel(target.entry.agentType)
      const { activeAgentNotesSendFailureMessage, sendNotesToActiveAgentSession } =
        await import('@/lib/active-agent-note-send')
      const result = await sendNotesToActiveAgentSession({
        worktreeId: mode.worktreeId,
        prompt: mode.prompt,
        noteTarget: { tabId: target.tabId, leafId: target.leafId }
      }).catch(() => {
        console.error('Failed to send notes to sidebar agent target:', {
          code: 'runtime-unverifiable'
        })
        return { status: 'status-unavailable' as const, code: 'runtime-unverifiable' as const }
      })

      const stillCurrent = (): boolean => {
        const current = get().agentSendPopoverTargetMode
        return current?.id === mode.id && current.instanceId === mode.instanceId
      }

      if (result.status !== 'sent') {
        const message = activeAgentNotesSendFailureMessage(result.status, {
          explicitTarget: true,
          code: result.code
        })
        set((s) =>
          s.agentSendPopoverTargetMode?.id === mode.id &&
          s.agentSendPopoverTargetMode.instanceId === mode.instanceId
            ? {
                agentSendPopoverTargetMode: {
                  ...s.agentSendPopoverTargetMode,
                  status: 'error',
                  sendingPaneKey: undefined,
                  error: message
                }
              }
            : s
        )
        const { toast } = await import('sonner')
        if (!stillCurrent()) {
          return false
        }
        toast.error(
          translate('auto.store.slices.ui.53883b7bc3', "Couldn't send to {{value0}}", {
            value0: label
          }),
          { description: message }
        )
        return false
      }

      // Delivery ack, telemetry, and toast belong to the completed send, not to the
      // picker that launched it; only the close below is scoped to this instance.
      mode.onPromptDelivered?.()
      const [{ toast }, { track }] = await Promise.all([
        import('sonner'),
        import('@/lib/telemetry')
      ])
      track('agent_prompt_sent', {
        agent_kind: agentKindForAgentType(target.entry.agentType),
        launch_source: mode.launchSource,
        request_kind: 'followup'
      })
      toast.success(
        translate('auto.store.slices.ui.66e3bd7ce6', 'Sent to {{value0}}', { value0: label })
      )
      get().closeAgentSendPopoverTargetMode(mode.id, mode.instanceId)
      return true
    }
  }
}
