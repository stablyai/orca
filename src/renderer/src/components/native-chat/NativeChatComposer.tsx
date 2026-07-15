import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState
} from 'react'
import { useAppStore } from '../../store'
import type { AgentType } from '../../../../shared/agent-status-types'
import { NATIVE_FILE_DROP_TARGET } from '../../../../shared/native-file-drop'
import { sendRuntimePtyInput } from '@/runtime/runtime-terminal-inspection'
import { getSettingsForAgentTabRuntimeOwner } from '@/lib/agent-paste-draft'
import {
  sendNativeChatMessage,
  sendNativeChatMessageWithImageAttachments,
  submitNativeChatPrompt
} from './native-chat-runtime-send'
import type { NativeChatSendHandle } from './native-chat-runtime-send'
import { getAgentSlashCommands } from './native-chat-agent-commands'
import { emitNativeChatMessageSent } from '@/lib/native-chat-telemetry'
import {
  applyMentionSuggestion,
  applySkillSuggestion,
  applySlashSuggestion,
  deriveComposerAutocomplete,
  EMPTY_HISTORY,
  isSlashCommandDraft,
  pushHistory,
  slashCommandDispatchText,
  type HistoryState,
  type SlashCommandSuggestion
} from './native-chat-composer-state'
import { readNativeChatDraftCache } from './native-chat-draft-cache'
import { useNativeChatDraft } from './use-native-chat-draft'
import { NativeChatComposerField } from './NativeChatComposerField'
import {
  nativeChatComposerTargetIsRemote,
  type NativeChatResolvedTarget
} from './native-chat-composer-target'
import { useNativeChatSkills } from './use-native-chat-skills'
import { useNativeChatComposerAttachments } from './use-native-chat-composer-attachments'
import { useNativeChatComposerPaste } from './use-native-chat-composer-paste'
import { useNativeChatExternalAttachments } from './use-native-chat-external-attachments'
import { dispatchDictationControl } from '../dictation/dictation-control-events'
import { useNativeChatComposerKeyDown } from './use-native-chat-composer-keydown'
import { useNativeChatSendLifecycle } from './use-native-chat-send-lifecycle'

// Why: a plain ESC byte is what the agent TUIs read as the interrupt key over a
// PTY (matching how xterm forwards Escape). The richer interrupt-intent
// inference (agent-interrupt-intent.ts) is driven by the existing PTY input
// observers, so writing ESC through the same send path feeds that machinery.
const ESC = '\x1b'

export type NativeChatComposerProps = {
  /** Tab hosting the agent; used to resolve the live ptyId + runtime settings. */
  terminalTabId: string
  /** Specific split-pane PTY this chat view owns. */
  targetPtyId: string | null
  agent: AgentType
  /**
   * Mobile presence-lock seam (R8): when a mobile client holds the pty, desktop
   * sends must be guarded rather than silently dropped. U9 wires the real lock
   * state in; until then this defaults to `true` (sendable) and the composer
   * already renders the guarded/disabled affordance when it is `false`.
   */
  canSend?: boolean
  /** True while the hosted TUI reports an in-flight turn; swaps Send to Stop. */
  isWorking?: boolean
  /** Interrupt the hosted agent, usually by sending ESC into the PTY. */
  onStop?: () => void
  /** Optional optimistic-send hook: called with the sent text so the view can
   *  render a "queued" echo until the real transcript turn lands (mobile parity). */
  onOptimisticSend?: (text: string, imagePaths?: string[]) => string | undefined
  /** Remove an optimistic echo when its delayed submit is canceled. */
  onOptimisticSendCanceled?: (pendingId: string) => void
  /** Called with a dispatched slash command (e.g. `/clear`) so the view can show
   *  a small "Ran /clear" system line — slash commands aren't chat turns and
   *  otherwise leave no visible trace that anything happened. */
  onSlashCommand?: (command: string) => void
}

export type NativeChatComposerHandle = {
  focus: () => boolean
  insertTypedText: (text: string) => boolean
  /** Handle a paste event captured at the pane root (the OS frequently
   *  retargets the paste off the focused textarea, so its own onPaste can't be
   *  relied on). An image is intercepted and attached; text falls through. */
  handlePasteEvent: (event: {
    clipboardData: DataTransfer | null
    preventDefault: () => void
    defaultPrevented: boolean
  }) => void
  /** Paste the clipboard into the composer with no event in hand (menu paste):
   *  an image becomes an attachment, otherwise text is inserted at the caret. */
  pasteFromClipboard: () => void
}

/**
 * Rich native input for the chat view. Sends prompts into the running agent
 * through the same verified runtime path as typed input (KTD4), so the agent
 * cannot distinguish native input from keystrokes. Enter sends; Shift+Enter
 * inserts a newline; multi-line is bracketed-paste wrapped; Esc interrupts.
 * Slash-command and `@file` autocomplete are agent-aware; image paste persists a
 * temp file and injects the agent-appropriate path (or reports unsupported).
 */
export const NativeChatComposer = forwardRef<NativeChatComposerHandle, NativeChatComposerProps>(
  function NativeChatComposer(
    {
      terminalTabId,
      targetPtyId,
      agent,
      canSend = true,
      isWorking = false,
      onStop,
      onOptimisticSend,
      onOptimisticSendCanceled,
      onSlashCommand
    },
    ref
  ): React.JSX.Element {
    // Scope key shared with image attachments so an unsent draft + its attached
    // images survive the composer unmounting on a TUI/GUI toggle.
    const draftScopeKey = targetPtyId ?? terminalTabId
    const { draft, setDraft } = useNativeChatDraft(draftScopeKey)
    const [caret, setCaret] = useState(draft.length)
    const [history, setHistory] = useState<HistoryState>(EMPTY_HISTORY)
    const [activeSuggestion, setActiveSuggestion] = useState(0)
    const [notice, setNotice] = useState<string | null>(null)
    const [dictationPressed, setDictationPressed] = useState(false)
    const skills = useNativeChatSkills(agent, terminalTabId)
    const textareaRef = useRef<HTMLTextAreaElement>(null)
    const { cancelPendingSends, trackPendingSend } = useNativeChatSendLifecycle(
      terminalTabId,
      targetPtyId,
      onOptimisticSendCanceled
    )
    const dictationState = useAppStore((store) => store.dictationState)
    const voiceSettings = useAppStore((store) => store.settings?.voice)
    const isDictationHoldMode = voiceSettings?.dictationMode === 'hold'
    const dictationDisabled = voiceSettings?.enabled !== true || !voiceSettings.sttModel
    const isDictating =
      dictationPressed ||
      dictationState === 'starting' ||
      dictationState === 'listening' ||
      dictationState === 'stopping'

    // Place the caret at the end of the (possibly restored) draft when the
    // composer is reused for a different pane. Adjusted during render (matching
    // the draft reload) so caret and text stay consistent on the first paint.
    const lastDraftScopeKey = useRef(draftScopeKey)
    if (lastDraftScopeKey.current !== draftScopeKey) {
      lastDraftScopeKey.current = draftScopeKey
      setCaret(readNativeChatDraftCache(draftScopeKey).length)
    }

    const agentCommands = useMemo(() => getAgentSlashCommands(agent), [agent])
    const autocomplete = useMemo(
      () =>
        deriveComposerAutocomplete(draft, caret, agentCommands, agent === 'codex' ? skills : []),
      [draft, caret, agentCommands, agent, skills]
    )

    // Resolve the live ptyId for this chat leaf; runtime owner settings route
    // local vs remote (SSH) sends.
    const resolveTarget = useCallback((): NativeChatResolvedTarget | null => {
      if (!targetPtyId) {
        return null
      }
      return { ptyId: targetPtyId, settings: getSettingsForAgentTabRuntimeOwner(terminalTabId) }
    }, [targetPtyId, terminalTabId])

    const hasPty = targetPtyId !== null
    const disabled = !hasPty || !canSend

    const syncCaret = useCallback((el: HTMLTextAreaElement) => {
      setCaret(el.selectionStart ?? el.value.length)
    }, [])

    const { imageAttachments, attachResolvedPaths, clearImageAttachments, removeImageAttachment } =
      useNativeChatComposerAttachments({
        attachmentScopeKey: targetPtyId ?? terminalTabId,
        caret,
        resolveTarget,
        textareaRef,
        setCaret,
        setDraft,
        setNotice
      })
    const sendButtonDisabled = isWorking
      ? !hasPty || !onStop
      : disabled || (draft.trim() === '' && imageAttachments.length === 0)

    const insertTypedText = useCallback(
      (text: string): boolean => {
        const textarea = textareaRef.current
        if (!textarea || textarea.disabled) {
          return false
        }
        const selectionStart = textarea.selectionStart ?? caret
        const selectionEnd = textarea.selectionEnd ?? selectionStart
        const next = `${draft.slice(0, selectionStart)}${text}${draft.slice(selectionEnd)}`
        const nextCaret = selectionStart + text.length
        textarea.focus()
        setDraft(next)
        setCaret(nextCaret)
        setHistory((prev) => ({ entries: prev.entries, index: null }))
        setActiveSuggestion(0)
        requestAnimationFrame(() => {
          textarea.setSelectionRange(nextCaret, nextCaret)
        })
        return true
      },
      [caret, draft, setDraft]
    )

    const focus = useCallback((): boolean => {
      const textarea = textareaRef.current
      if (!textarea || textarea.disabled) {
        return false
      }
      textarea.focus()
      return true
    }, [])

    const { attachExternalPaths, resolveAttachmentOwner } = useNativeChatExternalAttachments({
      terminalTabId,
      disabled,
      attachResolvedPaths,
      setNotice
    })

    const { handlePaste, pasteFromClipboard } = useNativeChatComposerPaste({
      agent,
      disabled,
      caret,
      resolveAttachmentOwner,
      attachResolvedPaths,
      insertTypedText,
      setCaret,
      setNotice
    })

    useImperativeHandle(
      ref,
      () => ({ focus, insertTypedText, handlePasteEvent: handlePaste, pasteFromClipboard }),
      [focus, insertTypedText, handlePaste, pasteFromClipboard]
    )

    useEffect(() => {
      return window.api.ui.onFileDrop((payload) => {
        if (payload.target !== NATIVE_FILE_DROP_TARGET.composer) {
          return
        }
        attachExternalPaths(payload.paths)
      })
    }, [attachExternalPaths])

    const pickAttachment = useCallback(() => {
      void (async () => {
        const filePath = await window.api.shell.pickAttachment()
        if (!filePath) {
          return
        }
        attachExternalPaths([filePath])
      })()
    }, [attachExternalPaths])

    const focusForDictation = useCallback(() => {
      textareaRef.current?.focus()
    }, [])

    const toggleDictation = useCallback(() => {
      focusForDictation()
      dispatchDictationControl('toggle')
    }, [focusForDictation])

    const startHoldDictation = useCallback(() => {
      setDictationPressed(true)
      focusForDictation()
      dispatchDictationControl('start')
    }, [focusForDictation])

    const stopHoldDictation = useCallback(() => {
      setDictationPressed(false)
      dispatchDictationControl('stop')
    }, [])

    const send = useCallback(() => {
      const text = draft
      const imagePaths = imageAttachments.map((attachment) => attachment.path)
      if ((text.trim() === '' && imagePaths.length === 0) || disabled) {
        return
      }
      const target = resolveTarget()
      if (!target) {
        return
      }
      // Slash commands are TUI controls, not chat turns — never attach images to
      // one (the chat turn is suppressed below, so the images would leak into the
      // runtime with no visible message). Otherwise images are deferred to submit
      // (like text) so the GUI chips and TUI input stay in sync and removing a
      // chip needs no TUI un-paste: send images, then text, then Enter atomically.
      const isSlashCommand = isSlashCommandDraft(text)
      let pendingHandle: NativeChatSendHandle | null = null
      if (isSlashCommand) {
        pendingHandle = sendNativeChatMessage(target.settings, target.ptyId, text)
      } else if (imagePaths.length > 0) {
        pendingHandle = sendNativeChatMessageWithImageAttachments(
          target.settings,
          target.ptyId,
          text,
          imagePaths
        )
      } else if (text.trim().length > 0) {
        pendingHandle = sendNativeChatMessage(target.settings, target.ptyId, text)
      } else {
        submitNativeChatPrompt(target.settings, target.ptyId)
      }
      // Slash commands don't echo a user bubble, but DO surface a small
      // "Ran /clear" system line so the command leaves a visible trace.
      if (isSlashCommand) {
        if (pendingHandle) {
          trackPendingSend(pendingHandle)
        }
        onSlashCommand?.(text.trim())
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
      clearImageAttachments()
      setNotice(null)
    }, [
      agent,
      clearImageAttachments,
      draft,
      imageAttachments,
      disabled,
      resolveTarget,
      onOptimisticSend,
      onSlashCommand,
      trackPendingSend,
      setDraft
    ])

    const interrupt = useCallback(() => {
      cancelPendingSends()
      if (isWorking && onStop) {
        onStop()
        return
      }
      const target = resolveTarget()
      if (!target) {
        return
      }
      sendRuntimePtyInput(target.settings, target.ptyId, ESC)
    }, [cancelPendingSends, isWorking, onStop, resolveTarget])

    const chooseSlash = useCallback(
      (command: SlashCommandSuggestion) => {
        const next = applySlashSuggestion(command)
        setDraft(next)
        setCaret(next.length)
        setActiveSuggestion(0)
        textareaRef.current?.focus()
      },
      [setDraft]
    )

    const dispatchSlash = useCallback(
      (command: SlashCommandSuggestion) => {
        const next = slashCommandDispatchText(command)
        const target = resolveTarget()
        if (!target || disabled) {
          return
        }
        trackPendingSend(sendNativeChatMessage(target.settings, target.ptyId, next))
        // Surface the command as a system line (this is the autocomplete-menu
        // dispatch path; the typed-Enter path in `send` does the same).
        onSlashCommand?.(next.trim())
        emitNativeChatMessageSent({
          agent,
          runtime: nativeChatComposerTargetIsRemote(target.ptyId) ? 'remote' : 'local'
        })
        setHistory((prev) => pushHistory(prev, next))
        setDraft('')
        setCaret(0)
        setActiveSuggestion(0)
        setNotice(null)
      },
      [agent, disabled, resolveTarget, onSlashCommand, setDraft, trackPendingSend]
    )

    const handleKeyDown = useNativeChatComposerKeyDown({
      autocomplete,
      activeSuggestion,
      draft,
      caret,
      history,
      chooseSlash,
      dispatchSlash,
      interrupt,
      send,
      setActiveSuggestion,
      setDraft,
      setCaret,
      setHistory
    })

    return (
      <NativeChatComposerField
        textareaRef={textareaRef}
        draft={draft}
        disabled={disabled}
        hasPty={hasPty}
        canSend={canSend}
        autocomplete={autocomplete}
        activeSuggestion={activeSuggestion}
        notice={notice}
        imageAttachments={imageAttachments}
        sendButtonDisabled={sendButtonDisabled}
        isWorking={isWorking}
        attachDisabled={disabled}
        dictationDisabled={dictationDisabled}
        isDictating={isDictating}
        isDictationHoldMode={isDictationHoldMode}
        onDraftChange={(value, element) => {
          setDraft(value)
          setHistory((prev) => ({ entries: prev.entries, index: null }))
          syncCaret(element)
          setActiveSuggestion(0)
        }}
        onTextareaSelect={syncCaret}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        onChooseSlash={chooseSlash}
        onAcceptMention={() => {
          if (autocomplete.mode !== 'mention') {
            return
          }
          const result = applyMentionSuggestion(draft, caret, autocomplete.query)
          setDraft(result.draft)
          setCaret(result.caret)
          textareaRef.current?.focus()
        }}
        onChooseSkill={(skill) => {
          const result = applySkillSuggestion(draft, caret, skill.name)
          setDraft(result.draft)
          setCaret(result.caret)
          setActiveSuggestion(0)
          textareaRef.current?.focus()
        }}
        onRemoveImageAttachment={(id) => removeImageAttachment(id)}
        onAttach={pickAttachment}
        onDictationToggle={toggleDictation}
        onDictationHoldStart={startHoldDictation}
        onDictationHoldEnd={stopHoldDictation}
        onSend={send}
        onStop={interrupt}
      />
    )
  }
)
