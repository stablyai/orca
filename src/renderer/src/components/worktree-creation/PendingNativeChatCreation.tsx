import React from 'react'
import { useAppStore } from '@/store'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { retryBackgroundWorktreeCreation } from '@/lib/worktree-creation-flow'
import { structuredAgentLabel } from '@/lib/structured-agent-session-launch-label'
import {
  pendingCreationChatDraftScopeKey,
  pendingCreationHeldChatMessage,
  type PendingWorktreeCreation
} from '@/lib/pending-worktree-creation'
import { shouldPreserveEditableFocus } from '@/components/terminal-pane/pane-helpers'
import {
  NativeChatComposer,
  type NativeChatComposerHandle
} from '@/components/native-chat/NativeChatComposer'
import type { NativeChatStructuredComposerTransport } from '@/components/native-chat/native-chat-composer-types'
import { deleteNativeChatComposerDraft } from '@/components/native-chat/native-chat-composer-draft-store'
import { useNativeChatComposerError } from '@/components/native-chat/use-native-chat-composer-notice'
import type { NativeChatComposerNotice } from '@/components/native-chat/native-chat-composer-notice'
import { NativeChatEmptyState } from '@/components/native-chat/NativeChatEmptyState'
import { NativeChatUserMessageRow } from '@/components/native-chat/NativeChatUserMessageRow'
import {
  NATIVE_CHAT_APPEARANCE_ROOT_CLASS,
  NATIVE_CHAT_TRANSCRIPT_COLUMN_CLASS,
  nativeChatTranscriptOuterClass
} from '@/components/native-chat/native-chat-appearance-style'
import { useNativeChatStoreAppearanceStyle } from '@/components/native-chat/use-native-chat-store-appearance-style'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { deriveNativeChatRowContent } from '../../../../shared/native-chat-row-content'
import type { SessionOptionsSurface } from '../../../../shared/native-chat/input/native-chat-session-options'
import WorktreeCreationTabStrip from './WorktreeCreationTabStrip'
import { WorktreeSetupSteps } from './WorktreeSetupSteps'
import { deriveWorktreeSetupSteps } from './worktree-setup-steps'
import { useWorktreeCreationClock } from './worktree-creation-clock'

const NO_OPTIONS_SURFACE: SessionOptionsSurface = {
  getSnapshot: () => [],
  setOption: async () => ({ snapshot: [] }),
  invokeAction: async () => ({ snapshot: [] }),
  subscribe: () => () => {}
}
const NO_COMMAND_CAUSES = {
  working: false,
  prompt: false,
  background: false,
  sending: false,
  retry: false
} as const

function failureText(entry: PendingWorktreeCreation): string {
  return (
    entry.error ??
    translate(
      'auto.components.worktree.creation.WorktreeCreationPanel.767951265d',
      'Something went wrong while creating the worktree.'
    )
  )
}

/** A native chat's own pane while its worktree is created: the composer takes the first message now and the launch sends it. */
export default function PendingNativeChatCreation({
  creationId,
  reserveCollapsedSidebarHeaderSpace = false
}: {
  creationId: string
  reserveCollapsedSidebarHeaderSpace?: boolean
}): React.JSX.Element | null {
  const entry = useAppStore((s) => s.pendingWorktreeCreations[creationId])
  const appearanceStyle = useNativeChatStoreAppearanceStyle()
  const composerRef = React.useRef<NativeChatComposerHandle>(null)
  const { composerError, reportComposerError } = useNativeChatComposerError(NO_COMMAND_CAUSES)
  const status = entry?.status
  const heldMessage = entry ? pendingCreationHeldChatMessage(entry) : null
  const held = heldMessage !== null
  // Like t3code, progress shows only in the steps card after a send, never above the composer.
  const now = useWorktreeCreationClock(status === 'creating' && held)
  const suppressFocus = entry?.request.suppressTerminalFocusOnCompletion === true

  const transport = React.useMemo((): NativeChatStructuredComposerTransport => {
    const sendBlockedReason =
      status === 'error'
        ? translate(
            'auto.components.worktree.creation.PendingNativeChatCreation.sendBlockedFailed',
            'Retry creating the worktree to send'
          )
        : held
          ? translate(
              'auto.components.worktree.creation.PendingNativeChatCreation.sendBlockedHeld',
              'Sends when the worktree is ready'
            )
          : undefined
    return {
      capturePresentation: () => () => true,
      // Commands go to the agent as the first message, so nothing is handled here.
      dispatchCommand: async () => ({ handled: false, accepted: false, error: null }),
      send: (text) => {
        const store = useAppStore.getState()
        const current = store.pendingWorktreeCreations[creationId]
        if (
          !current ||
          current.status !== 'creating' ||
          pendingCreationHeldChatMessage(current) !== null
        ) {
          return false
        }
        store.updatePendingWorktreeCreation(creationId, { heldChatMessage: text })
        return true
      },
      ...(sendBlockedReason ? { sendBlockedReason } : {}),
      optionsSurface: NO_OPTIONS_SURFACE,
      optionSnapshot: [],
      acceptsImages: false,
      onError: reportComposerError,
      runtime: 'local',
      sessionId: pendingCreationChatDraftScopeKey(creationId),
      runtimeEnvironmentId: null
    }
  }, [creationId, held, reportComposerError, status])

  const notices = React.useMemo(
    (): NativeChatComposerNotice[] =>
      composerError ? [{ key: 'composer-error', kind: 'error', ...composerError }] : [],
    [composerError]
  )

  // Runs once per creation (suppressFocus is fixed at submit); a field elsewhere keeps its focus.
  React.useEffect(() => {
    if (suppressFocus) {
      return
    }
    const frame = requestAnimationFrame(() => {
      if (!shouldPreserveEditableFocus(document.activeElement)) {
        composerRef.current?.focus()
      }
    })
    return () => cancelAnimationFrame(frame)
  }, [suppressFocus])

  if (!entry || entry.request.agent === null) {
    return null
  }
  const agent = entry.request.agent
  const agentLabel = structuredAgentLabel(agent)
  const isError = entry.status === 'error'
  const tabId = `${pendingCreationChatDraftScopeKey(creationId)}:tab`
  // Explicit back-outs drop the unsent draft; completion leaves it for the launch to move.
  const dismiss = (): void => {
    useAppStore.getState().removePendingWorktreeCreation(creationId)
    deleteNativeChatComposerDraft(pendingCreationChatDraftScopeKey(creationId))
  }
  const steps =
    held || isError ? (
      <WorktreeSetupSteps
        steps={deriveWorktreeSetupSteps(entry, now)}
        agentLabel={agentLabel}
        error={isError ? failureText(entry) : null}
        onRetry={() => retryBackgroundWorktreeCreation(creationId)}
        onDismiss={dismiss}
      />
    ) : null

  return (
    <div className="absolute inset-0 flex flex-col bg-background">
      <WorktreeCreationTabStrip
        title={entry.request.displayName || entry.request.name}
        isError={isError}
        reserveCollapsedSidebarHeaderSpace={reserveCollapsedSidebarHeaderSpace}
        onCancel={dismiss}
      />
      <div
        data-native-chat-root="true"
        className={cn(NATIVE_CHAT_APPEARANCE_ROOT_CLASS, 'flex min-h-0 w-full flex-1 flex-col')}
        style={appearanceStyle}
        data-native-chat-scheme={appearanceStyle.colorScheme}
      >
        <div className="relative flex min-h-0 flex-1 flex-col bg-chat-canvas">
          {steps ? (
            <div className="scrollbar-sleek min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable_both-edges]">
              <div className={nativeChatTranscriptOuterClass(false)}>
                <div className={NATIVE_CHAT_TRANSCRIPT_COLUMN_CLASS}>
                  {heldMessage !== null ? (
                    <HeldMessageRow creationId={creationId} text={heldMessage} />
                  ) : null}
                  {steps}
                </div>
              </div>
            </div>
          ) : (
            <NativeChatEmptyState kind="empty" agent={agent} />
          )}
        </div>
        <NativeChatComposer
          ref={composerRef}
          terminalTabId={tabId}
          paneKey={`${tabId}:composer`}
          draftScopeKey={pendingCreationChatDraftScopeKey(creationId)}
          targetPtyId={null}
          agent={agent}
          structuredTransport={transport}
          notices={notices}
          workspacePending
        />
      </div>
    </div>
  )
}

function HeldMessageRow({
  creationId,
  text
}: {
  creationId: string
  text: string
}): React.JSX.Element {
  const rowRef = React.useRef<HTMLDivElement | null>(null)
  const message = React.useMemo(
    (): NativeChatMessage => ({
      id: `${pendingCreationChatDraftScopeKey(creationId)}:first-message`,
      role: 'user',
      blocks: [{ type: 'text', text }],
      timestamp: null,
      source: 'transcript'
    }),
    [creationId, text]
  )
  const { markdown, prose } = deriveNativeChatRowContent(message.blocks)
  return (
    <NativeChatUserMessageRow
      message={message}
      markdown={markdown}
      prose={prose}
      rowRef={rowRef}
      onRefolded={() => {}}
      allowFileUriLinks={false}
    />
  )
}
