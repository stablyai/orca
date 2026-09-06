// The composer's Send dispatch, extracted from NativeChatComposer.tsx to stay
// under the file's line ratchet (wave 1 hit the same cap and split similarly).
// Owns structured, PTY, and RPC routing in one send boundary.

import { useCallback } from 'react'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '../../store'
import type { AgentType } from '../../../../shared/agent-status-types'
import {
  isSlashCommandDraft,
  type NativeChatSendClassification
} from '../../../../shared/native-chat-slash-commands'
import type { NativeChatPtySessionOptionsSurface } from './native-chat-pty-session-options'
import type { NativeChatLaunchDraft } from '@/lib/native-chat-launch-prompt'
import { emitNativeChatMessageSent } from '@/lib/native-chat-telemetry'
import {
  sendNativeChatMessage,
  sendNativeChatTypedCommand,
  submitNativeChatPrompt,
  type NativeChatSendHandle
} from './native-chat-runtime-send'
import { sendNativeChatMessageWithImageAttachments } from './native-chat-runtime-image-send'
import { resolveNativeChatLaunchDraftSend } from './native-chat-launch-draft-send'
import {
  nativeChatComposerTargetIsRemote,
  type NativeChatResolvedTarget
} from './native-chat-composer-target'
import { pushHistory, type HistoryState } from './native-chat-composer-state'
import { useNativeChatStructuredComposerSend } from './use-native-chat-structured-composer-send'
import type { NativeChatCommandMarkerOutcome } from './native-chat-command-marker'
import type { NativeChatComposerImageAttachment } from './NativeChatComposerField'
import type { NativeChatStructuredComposerTransport } from './native-chat-composer-types'

export type UseNativeChatComposerSendArgs = {
  agent: AgentType
  terminalTabId: string
  draft: string
  imageAttachments: readonly NativeChatComposerImageAttachment[]
  structuredTransport?: NativeChatStructuredComposerTransport
  /** A pasted image has no agent-readable path until its save lands; sending
   *  mid-save would ship the message without the image the chip promises. */
  hasPendingAttachment: boolean
  disabled: boolean
  isDispatchingSessionOption: boolean
  launchDraft?: NativeChatLaunchDraft | null
  launchDraftResolved: boolean
  readTerminalScreen?: () => string | null
  resolveTarget: () => NativeChatResolvedTarget | null
  classifySend: (text: string) => NativeChatSendClassification
  /** `/usage`-style local commands run over the session-less RPC probe. */
  sendOmpLocalCommand: (text: string) => boolean
  /** A plain chat prompt routed through the pane's RPC-owned session (D1/D6). */
  sendOmpRpcChat: (text: string) => boolean
  /** A catalog slash command routed through that same owned session. */
  sendOmpRpcCommand: (text: string) => boolean
  onSlashCommand?: (command: string, outcome?: NativeChatCommandMarkerOutcome) => void
  onOptimisticSend?: (text: string, imagePaths?: string[]) => string | undefined
  sessionOptionsSurface: NativeChatPtySessionOptionsSurface | null
  trackPendingSend: (handle: NativeChatSendHandle, pendingId?: string) => void
  setHistory: (updater: (prev: HistoryState) => HistoryState) => void
  setDraft: (value: string) => void
  setCaret: (value: number) => void
  clearSkillOrigin: () => void
  clearImageAttachments: () => void
  setNotice: (value: string | null) => void
}

export function useNativeChatComposerSend(
  args: UseNativeChatComposerSendArgs
): (textOverride?: string) => void {
  const {
    agent,
    terminalTabId,
    draft,
    imageAttachments,
    structuredTransport,
    hasPendingAttachment,
    disabled,
    isDispatchingSessionOption,
    launchDraft,
    launchDraftResolved,
    readTerminalScreen,
    resolveTarget,
    classifySend,
    sendOmpLocalCommand,
    sendOmpRpcChat,
    sendOmpRpcCommand,
    onSlashCommand,
    onOptimisticSend,
    sessionOptionsSurface,
    trackPendingSend,
    setHistory,
    setDraft,
    setCaret,
    clearSkillOrigin,
    clearImageAttachments,
    setNotice
  } = args

  // The structured journal route keeps its own send/clear semantics in its own
  // hook; this hook stays the single place that decides WHICH route a draft takes.
  const sendStructured = useNativeChatStructuredComposerSend({
    agent,
    imageAttachments,
    structuredTransport,
    clearImageAttachments,
    clearSkillOrigin,
    setHistory,
    setDraft,
    setCaret
  })

  return useCallback(
    (textOverride?: string) => {
      if (hasPendingAttachment) {
        return
      }
      const text = textOverride ?? draft
      const imagePaths = imageAttachments.map((attachment) => attachment.path)
      if ((text.trim() === '' && imagePaths.length === 0) || disabled) {
        return
      }
      if (structuredTransport) {
        sendStructured(text, imageAttachments)
        return
      }
      // Why: block a normal send while a session-option command (e.g. /model) is
      // still writing its body+delayed-Enter to the same pty, so the two write
      // sequences can't interleave on one input line.
      if (isDispatchingSessionOption) {
        return
      }
      const classification = classifySend(text)
      // Why: a catalog command on an RPC-owned pane has no PTY left to type into,
      // so it runs over the owning session. Asked before the session-less probe
      // below because only this call can tell whether OMP's published catalog
      // proves the session executes the command — when it does, that beats a
      // probe answering for a session the pane is not in. Text-only: there is no
      // RPC image UI this wave, so an attachment keeps the PTY path.
      if (classification !== 'chat' && imagePaths.length === 0 && sendOmpRpcCommand(text)) {
        emitNativeChatMessageSent({ agent, runtime: 'local' })
        sessionOptionsSurface?.recordOutgoingCommand(text.trim())
        setHistory((prev) => pushHistory(prev, text))
        setDraft('')
        setCaret(0)
        clearSkillOrigin()
        setNotice(null)
        return
      }
      // Why: `/usage` is a LOCAL command — running it over RPC returns its output
      // to render here instead of leaving it only on the TUI screen. Every other
      // command (and a failed probe) keeps the PTY path below untouched. Tried
      // before resolving a PTY target: the RPC probe needs no live terminal (D1)
      // — an RPC-owned pane's PTY was killed on acquire, and this must not be
      // the thing that makes a *successful* acquisition break sending.
      if (sendOmpLocalCommand(text)) {
        setHistory((prev) => pushHistory(prev, text))
        setDraft('')
        setCaret(0)
        clearSkillOrigin()
        setNotice(null)
        return
      }
      // Why: route a plain chat prompt through the RPC session that owns this
      // pane before any PTY fallback (D1/D6); text-only, since there is no RPC
      // image UI this wave — an attachment always keeps the PTY path. Tried
      // before resolving a PTY target for the same reason as the command routes
      // above — this is the route an RPC-owned, PTY-less pane actually sends on.
      if (classification === 'chat' && imagePaths.length === 0 && sendOmpRpcChat(text)) {
        emitNativeChatMessageSent({ agent, runtime: 'local' })
        setHistory((prev) => pushHistory(prev, text))
        setDraft('')
        setCaret(0)
        clearSkillOrigin()
        clearImageAttachments()
        setNotice(null)
        useAppStore.getState().clearNativeChatLaunchDraft(terminalTabId)
        return
      }
      const target = resolveTarget()
      if (!target) {
        // Nothing above claimed the draft, and there is no PTY to fall back
        // into — an RPC-owned pane's PTY is gone by design (D1). What's left
        // is a PTY-only affordance the RPC route can't carry: an image
        // attachment (RPC send is text-only), or a command the owning session
        // also declined (no session, or not an OMP pane).
        if (imagePaths.length > 0) {
          setNotice(
            translate(
              'components.native-chat.composer.imagesRequirePty',
              'Image attachments need a live terminal; remove them to send this as a chat message.'
            )
          )
        } else if (classification !== 'chat') {
          setNotice(
            translate(
              'components.native-chat.composer.commandRequiresPty',
              'This command needs a live terminal and cannot run over the agent connection.'
            )
          )
        }
        return
      }
      // A parked launch draft must be cleared line-by-line before the body.
      const { sendOptions } = resolveNativeChatLaunchDraftSend({
        launchDraft,
        launchDraftResolved,
        agent,
        readScreen: () => readTerminalScreen?.()
      })
      let pendingHandle: NativeChatSendHandle | null = null
      // Why: image attachments take the attachment send path even for a
      // command/unknown send, otherwise `clearImageAttachments()` below drops
      // them silently when the text starts with the agent's slash/skill prefix.
      if (classification !== 'chat' && imagePaths.length === 0) {
        pendingHandle =
          agent === 'codex' && isSlashCommandDraft(text)
            ? sendNativeChatTypedCommand(target.settings, target.ptyId, text)
            : sendNativeChatMessage(target.settings, target.ptyId, text, sendOptions)
      } else if (imagePaths.length > 0) {
        pendingHandle = sendNativeChatMessageWithImageAttachments(
          target.settings,
          target.ptyId,
          text,
          imagePaths,
          sendOptions
        )
      } else if (text.trim().length > 0) {
        pendingHandle = sendNativeChatMessage(target.settings, target.ptyId, text, sendOptions)
      } else {
        submitNativeChatPrompt(target.settings, target.ptyId)
      }
      if (classification !== 'chat') {
        if (pendingHandle) {
          trackPendingSend(pendingHandle)
        }
        // Why: only verified catalog commands can truthfully claim they ran or
        // mutate session-option state; unknown slash-like text has no such proof.
        if (classification === 'command') {
          onSlashCommand?.(text.trim())
          sessionOptionsSurface?.recordOutgoingCommand(text.trim())
        }
      } else {
        const pendingId = onOptimisticSend?.(text, imagePaths)
        if (pendingHandle) {
          trackPendingSend(pendingHandle, pendingId)
        }
      }
      // Why: U10 telemetry — record adoption + local-vs-remote runtime split. The
      // agent prop is the loose AgentType; the emitter narrows unknowns to 'other'.
      emitNativeChatMessageSent({
        agent,
        runtime: nativeChatComposerTargetIsRemote(target.ptyId) ? 'remote' : 'local'
      })
      setHistory((prev) => pushHistory(prev, text))
      setDraft('')
      setCaret(0)
      clearSkillOrigin()
      clearImageAttachments()
      setNotice(null)
      // The send cleared the TUI input line before its body, so retire the seed.
      useAppStore.getState().clearNativeChatLaunchDraft(terminalTabId)
    },
    [
      agent,
      clearSkillOrigin,
      clearImageAttachments,
      draft,
      imageAttachments,
      disabled,
      isDispatchingSessionOption,
      launchDraft,
      launchDraftResolved,
      readTerminalScreen,
      resolveTarget,
      classifySend,
      onOptimisticSend,
      onSlashCommand,
      sendOmpLocalCommand,
      sendOmpRpcChat,
      sendOmpRpcCommand,
      structuredTransport,
      sendStructured,
      hasPendingAttachment,
      sessionOptionsSurface,
      terminalTabId,
      trackPendingSend,
      setDraft,
      setHistory,
      setCaret,
      setNotice
    ]
  )
}
