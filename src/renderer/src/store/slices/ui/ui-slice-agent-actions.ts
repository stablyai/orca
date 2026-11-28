import type { UISlice, UISliceGet, UISliceSet } from './ui-slice-contract'
import { formatAgentTypeLabel } from '../../../../../shared/agent-status/presentation/agent-type-label'
import { agentKindForAgentType } from '../../../lib/agent-status/aggregation/worktree-agent-status'
import {
  deriveRunningAgentSendTargets,
  resolveRunningAgentSendTarget,
  runningAgentMessageTarget,
  runningAgentSendTargetAgentType
} from '../../../lib/agent-session/messaging/running-agent-targets'
import { translate } from '@/i18n/i18n'
import { activeAgentNotesSendFailureMessage } from '@/lib/agent-session/messaging/terminal/active-agent-note-send-result'
import { createUiActivityActions } from './ui-slice-activity-actions'
import { selectKnownWorktreeById } from '../../workspaces/selection/known-worktree-selection'
import { combinedUncommittedDiffId } from '../editor/git/open-combined-diff'
import { editorOpenOwner } from '../editor/git/editor-open-owner'
import { editorViewTab } from '../editor/tabs/editor-view-placement'
import { selectDiffCommentView } from '../diff-comments/diff-comment-owner'
import {
  diffCommentSendKey,
  isNoteInFlight
} from '@/components/notes/delivery/notes-send-in-flight'
import {
  isMarkdownReviewNotesEnabled,
  withoutMarkdownReviewNotes
} from '@/lib/editor/markdown/review-notes/markdown-review-notes-setting'

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
        // Why switch: the send targets render on workspace cards, not activity rows.
        get().setSidebarBody('workspaces')
        get().revealWorktreeInSidebar(args.worktreeId, { behavior: 'auto', highlight: true })
      }
    },
    diffNotesSendMenuOpenRequest: null,
    openDiffNotesSendMenuForActiveWorktree: () => {
      const state = get()
      const worktreeId = state.activeWorktreeId
      if (!worktreeId) {
        return false
      }
      const worktree = selectKnownWorktreeById(state, worktreeId)
      if (!worktree) {
        return false
      }
      const contentOwner = editorOpenOwner(state, worktreeId)
      const changesId = combinedUncommittedDiffId(worktreeId, contentOwner)
      const changesFile = state.openFiles.find((file) => file.id === changesId)
      const { owner, comments } = selectDiffCommentView(
        state,
        worktreeId,
        changesFile ?? contentOwner
      )
      const visible =
        comments && !isMarkdownReviewNotesEnabled(state.settings)
          ? withoutMarkdownReviewNotes(comments)
          : comments
      if (
        !owner ||
        !visible?.some((note) => !note.sentAt && !isNoteInFlight(diffCommentSendKey(owner, note)))
      ) {
        return false
      }

      // Reopening an existing Changes tab would replace its entry snapshots and comparison.
      const changesTab = changesFile ? editorViewTab(state, changesId) : undefined
      if (changesTab) {
        get().activateTab(changesTab.id, { worktreeId })
        get().setActiveFile(changesId, worktreeId)
      } else {
        get().openAllDiffs(worktreeId, worktree.path)
      }
      const openedTab = editorViewTab(get(), changesId)
      if (!openedTab) {
        return false
      }
      const nonce = (get().diffNotesSendMenuOpenRequest?.nonce ?? 0) + 1
      set({
        diffNotesSendMenuOpenRequest: {
          worktreeId,
          fileId: changesId,
          tabId: openedTab.id,
          nonce,
          issuedAt: Date.now()
        }
      })
      return true
    },
    consumeDiffNotesSendMenuOpenRequest: (request) => {
      const state = get()
      if (state.diffNotesSendMenuOpenRequest !== request) {
        return false
      }
      set({ diffNotesSendMenuOpenRequest: null })
      return (
        state.activeWorktreeId === request.worktreeId &&
        state.activeFileId === request.fileId &&
        editorViewTab(state, request.fileId)?.id === request.tabId
      )
    },
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
      // An empty prompt has nothing to send: every note may already be on its way.
      if (!mode || mode.status === 'sending' || !mode.prompt.trim()) {
        return false
      }
      if (mode.canSendPrompt && !mode.canSendPrompt()) {
        get().closeAgentSendPopoverTargetMode(mode.id, mode.instanceId)
        return false
      }

      const target = resolveRunningAgentSendTarget(get(), mode.worktreeId, paneKey)
      if (
        !target ||
        target.status !== 'eligible' ||
        (target.kind === 'terminal' && !target.ptyId)
      ) {
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

      const agentType = runningAgentSendTargetAgentType(target)
      const label = formatAgentTypeLabel(agentType)
      // Reserve the captured notes before loading the delivery code.
      const sending = Promise.resolve()
        .then(async () => {
          const [, { sendMessageToAgent }] = await Promise.all([
            import('@/lib/agent-session/messaging/terminal/active-agent-note-send'),
            import('@/lib/agent-session/messaging/agent-message-send')
          ])
          return sendMessageToAgent({
            worktreeId: mode.worktreeId,
            prompt: mode.prompt,
            target: runningAgentMessageTarget(target)
          })
        })
        .catch(() => {
          console.error('Failed to send notes to sidebar agent target:', {
            code: 'runtime-unverifiable'
          })
          return { status: 'status-unavailable' as const, code: 'runtime-unverifiable' as const }
        })
        .then((sendResult) => {
          if (sendResult.status === 'sent') {
            mode.onPromptDelivered?.()
          }
          return sendResult
        })
      mode.onPromptHandedOff?.(sending)
      const result = await sending

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

      // Completed-send delivery/telemetry/toast outlive the picker; only closing it is scoped to this instance.
      const [{ toast }, { track }] = await Promise.all([
        import('sonner'),
        import('@/diagnostics/telemetry/telemetry')
      ])
      track('agent_prompt_sent', {
        agent_kind: agentKindForAgentType(agentType),
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
