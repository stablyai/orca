import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '../../store'
import type { AgentType } from '../../../../shared/agent-status-types'
import { NATIVE_FILE_DROP_TARGET } from '../../../../shared/native-file-drop'
import { sendRuntimePtyInput } from '@/runtime/runtime-terminal-inspection'
import { getSettingsForAgentTabRuntimeOwner } from '@/lib/agent-paste-draft'
import { sendNativeChatMessage } from './native-chat-runtime-send'
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
  recallNext,
  recallPrevious,
  slashCommandDispatchText,
  type HistoryState,
  type SlashCommandSuggestion
} from './native-chat-composer-state'
import { resolveImagePaste } from './native-chat-image-paste'
import { NativeChatComposerField } from './NativeChatComposerField'
import { formatNativeChatFileReference } from './native-chat-composer-target'
import {
  nativeChatComposerTargetIsRemote,
  type NativeChatResolvedTarget
} from './native-chat-composer-target'
import { useNativeChatSkills } from './use-native-chat-skills'

// Why: a plain ESC byte is what the agent TUIs read as the interrupt key over a
// PTY (matching how xterm forwards Escape). The richer interrupt-intent
// inference (agent-interrupt-intent.ts) is driven by the existing PTY input
// observers, so writing ESC through the same send path feeds that machinery.
const ESC = '\x1b'

export type NativeChatComposerProps = {
  /** Tab hosting the agent; used to resolve the live ptyId + runtime settings. */
  terminalTabId: string
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
  onOptimisticSend?: (text: string) => void
  /** Called with a dispatched slash command (e.g. `/clear`) so the view can show
   *  a small "Ran /clear" system line — slash commands aren't chat turns and
   *  otherwise leave no visible trace that anything happened. */
  onSlashCommand?: (command: string) => void
}

/**
 * Rich native input for the chat view. Sends prompts into the running agent
 * through the same verified runtime path as typed input (KTD4), so the agent
 * cannot distinguish native input from keystrokes. Enter sends; Shift+Enter
 * inserts a newline; multi-line is bracketed-paste wrapped; Esc interrupts.
 * Slash-command and `@file` autocomplete are agent-aware; image paste persists a
 * temp file and injects the agent-appropriate path (or reports unsupported).
 */
export function NativeChatComposer({
  terminalTabId,
  agent,
  canSend = true,
  isWorking = false,
  onStop,
  onOptimisticSend,
  onSlashCommand
}: NativeChatComposerProps): React.JSX.Element {
  const [draft, setDraft] = useState('')
  const [caret, setCaret] = useState(0)
  const [history, setHistory] = useState<HistoryState>(EMPTY_HISTORY)
  const [activeSuggestion, setActiveSuggestion] = useState(0)
  const [notice, setNotice] = useState<string | null>(null)
  const skills = useNativeChatSkills(agent, terminalTabId)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const agentCommands = useMemo(() => getAgentSlashCommands(agent), [agent])
  const autocomplete = useMemo(
    () => deriveComposerAutocomplete(draft, caret, agentCommands, agent === 'codex' ? skills : []),
    [draft, caret, agentCommands, agent, skills]
  )

  // Resolve the live ptyId for this tab the same way agent-paste-draft does:
  // ptyIdsByTabId carries the pane's primary pty, and the runtime owner settings
  // route local vs remote (SSH) sends.
  const resolveTarget = useCallback((): NativeChatResolvedTarget | null => {
    const ptyId = useAppStore.getState().ptyIdsByTabId[terminalTabId]?.[0]
    if (!ptyId) {
      return null
    }
    return { ptyId, settings: getSettingsForAgentTabRuntimeOwner(terminalTabId) }
  }, [terminalTabId])

  const hasPty = Boolean(useAppStore((s) => s.ptyIdsByTabId[terminalTabId]?.[0]))
  const disabled = !hasPty || !canSend
  const sendButtonDisabled = isWorking ? !hasPty || !onStop : disabled || draft.trim() === ''

  const syncCaret = useCallback((el: HTMLTextAreaElement) => {
    setCaret(el.selectionStart ?? el.value.length)
  }, [])

  const insertFileReferences = useCallback(
    (paths: string[]) => {
      const target = resolveTarget()
      if (!target || nativeChatComposerTargetIsRemote(target.ptyId)) {
        setNotice(
          translate(
            'components.native-chat.composer.localAttachmentUnsupported',
            'Local attachments are not available for remote sessions.'
          )
        )
        return
      }
      const references = paths.map(formatNativeChatFileReference).join(' ')
      if (references.length === 0) {
        return
      }
      const insertion = `${references} `
      const caretAtInsert = textareaRef.current?.selectionStart ?? caret
      setDraft((prev) => {
        const before = prev.slice(0, caretAtInsert)
        const after = prev.slice(caretAtInsert)
        const next = before + insertion + after
        setCaret(before.length + insertion.length)
        return next
      })
      setNotice(null)
      requestAnimationFrame(() => textareaRef.current?.focus())
    },
    [caret, resolveTarget]
  )

  useEffect(() => {
    return window.api.ui.onFileDrop((payload) => {
      if (payload.target !== NATIVE_FILE_DROP_TARGET.composer) {
        return
      }
      insertFileReferences(payload.paths)
    })
  }, [insertFileReferences])

  const pickAttachment = useCallback(() => {
    void (async () => {
      const target = resolveTarget()
      if (!target || nativeChatComposerTargetIsRemote(target.ptyId)) {
        setNotice(
          translate(
            'components.native-chat.composer.localAttachmentUnsupported',
            'Local attachments are not available for remote sessions.'
          )
        )
        return
      }
      const filePath = await window.api.shell.pickAttachment()
      if (!filePath) {
        return
      }
      insertFileReferences([filePath])
    })()
  }, [insertFileReferences, resolveTarget])

  const send = useCallback(() => {
    const text = draft
    if (text.trim() === '' || disabled) {
      return
    }
    const target = resolveTarget()
    if (!target) {
      return
    }
    // Two-write send (body, then a delayed Enter) so the agent TUI submits the
    // message instead of leaving it in its input box (R6: works for SSH panes).
    sendNativeChatMessage(target.settings, target.ptyId, text)
    // Slash commands are TUI controls, not chat turns: don't echo a user bubble,
    // but DO surface a small "Ran /clear" system line so the command leaves a
    // visible trace instead of seeming to do nothing.
    if (isSlashCommandDraft(text)) {
      onSlashCommand?.(text.trim())
    } else {
      onOptimisticSend?.(text)
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
    setNotice(null)
  }, [agent, draft, disabled, resolveTarget, onOptimisticSend, onSlashCommand])

  const interrupt = useCallback(() => {
    if (isWorking && onStop) {
      onStop()
      return
    }
    const target = resolveTarget()
    if (!target) {
      return
    }
    sendRuntimePtyInput(target.settings, target.ptyId, ESC)
  }, [isWorking, onStop, resolveTarget])

  const chooseSlash = useCallback((command: SlashCommandSuggestion) => {
    const next = applySlashSuggestion(command)
    setDraft(next)
    setCaret(next.length)
    setActiveSuggestion(0)
    textareaRef.current?.focus()
  }, [])

  const dispatchSlash = useCallback(
    (command: SlashCommandSuggestion) => {
      const next = slashCommandDispatchText(command)
      const target = resolveTarget()
      if (!target || disabled) {
        return
      }
      sendNativeChatMessage(target.settings, target.ptyId, next)
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
    [agent, disabled, resolveTarget, onSlashCommand]
  )

  const handlePaste = useCallback(
    (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const hasImage = Array.from(event.clipboardData.items).some((item) =>
        item.type.startsWith('image/')
      )
      if (!hasImage) {
        return
      }
      event.preventDefault()
      // Why: snapshot the caret before the async temp-file round-trip — `caret`
      // state can move (further typing/selection) while the await is in flight.
      const caretAtPaste = caret
      void (async () => {
        const tempPath = await window.api.ui.saveClipboardImageAsTempFile()
        if (!tempPath) {
          return
        }
        const result = resolveImagePaste(agent, tempPath)
        if (result.kind === 'unsupported') {
          setNotice(
            translate(
              'components.native-chat.composer.imageUnsupported',
              'Image paste is not supported for this agent.'
            )
          )
          return
        }
        // Insert the path at the caret as plain draft text; the agent resolves
        // the file path to an attachment.
        setDraft((prev) => {
          const before = prev.slice(0, caretAtPaste)
          const after = prev.slice(caretAtPaste)
          const insertion = `${result.reference} `
          const next = before + insertion + after
          setCaret(before.length + insertion.length)
          return next
        })
        setNotice(null)
      })()
    },
    [agent, caret]
  )

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // Autocomplete navigation takes priority over send while a menu is open.
      if (autocomplete.mode === 'slash' && autocomplete.suggestions.length > 0) {
        if (event.key === 'ArrowDown') {
          event.preventDefault()
          setActiveSuggestion((i) => (i + 1) % autocomplete.suggestions.length)
          return
        }
        if (event.key === 'ArrowUp') {
          event.preventDefault()
          setActiveSuggestion(
            (i) => (i - 1 + autocomplete.suggestions.length) % autocomplete.suggestions.length
          )
          return
        }
        if (event.key === 'Enter') {
          event.preventDefault()
          dispatchSlash(autocomplete.suggestions[activeSuggestion] ?? autocomplete.suggestions[0])
          return
        }
        if (event.key === 'Tab') {
          event.preventDefault()
          chooseSlash(autocomplete.suggestions[activeSuggestion] ?? autocomplete.suggestions[0])
          return
        }
        if (event.key === 'Escape') {
          event.preventDefault()
          setDraft('')
          setCaret(0)
          return
        }
      }

      if (autocomplete.mode === 'skill') {
        if (event.key === 'ArrowDown' && autocomplete.suggestions.length > 0) {
          event.preventDefault()
          setActiveSuggestion((i) => (i + 1) % autocomplete.suggestions.length)
          return
        }
        if (event.key === 'ArrowUp' && autocomplete.suggestions.length > 0) {
          event.preventDefault()
          setActiveSuggestion(
            (i) => (i - 1 + autocomplete.suggestions.length) % autocomplete.suggestions.length
          )
          return
        }
        if ((event.key === 'Enter' || event.key === 'Tab') && autocomplete.suggestions.length > 0) {
          event.preventDefault()
          const skill = autocomplete.suggestions[activeSuggestion] ?? autocomplete.suggestions[0]
          const result = applySkillSuggestion(draft, caret, skill.name)
          setDraft(result.draft)
          setCaret(result.caret)
          setActiveSuggestion(0)
          return
        }
        if (event.key === 'Escape') {
          event.preventDefault()
          setDraft('')
          setCaret(0)
          return
        }
      }

      if (event.key === 'Escape') {
        event.preventDefault()
        interrupt()
        return
      }

      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault()
        send()
        return
      }

      // History recall only on an empty draft (or while already recalling), so
      // arrow keys still move the caret inside real multi-line text.
      if (event.key === 'ArrowUp' && (draft === '' || history.index !== null)) {
        const recall = recallPrevious(history)
        if (recall.draft !== null) {
          event.preventDefault()
          setHistory(recall.history)
          setDraft(recall.draft)
          setCaret(recall.draft.length)
        }
        return
      }
      if (event.key === 'ArrowDown' && history.index !== null) {
        const recall = recallNext(history)
        if (recall.draft !== null) {
          event.preventDefault()
          setHistory(recall.history)
          setDraft(recall.draft)
          setCaret(recall.draft.length)
        }
      }
    },
    [
      autocomplete,
      activeSuggestion,
      chooseSlash,
      dispatchSlash,
      interrupt,
      send,
      draft,
      caret,
      history
    ]
  )

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
      sendButtonDisabled={sendButtonDisabled}
      isWorking={isWorking}
      attachDisabled={disabled}
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
      onAttach={pickAttachment}
      onSend={send}
      onStop={onStop}
    />
  )
}
