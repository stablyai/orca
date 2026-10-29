import {
  writeNativeChatComposerText,
  type NativeChatComposerInput
} from './native-chat-composer-input'
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction
} from 'react'
import type { AgentType } from '../../../../shared/agent-status-types'
import { getNativeChatAgentProfile } from '../../../../shared/native-chat-agent-profiles'
import type {
  NativeChatSessionSkill,
  SlashCommandSuggestion
} from '../../../../shared/native-chat/input/native-chat-slash-commands'
import {
  applyMentionSuggestion,
  applyPickerSuggestion,
  classifyNativeChatSend,
  deriveComposerAutocomplete,
  editReplacesTriggerToken,
  isSkillPickerTriggered,
  type ComposerAutocomplete,
  type NativeChatPickerItem,
  type NativeChatSendClassification
} from '../../../../shared/native-chat-composer-autocomplete'
import { nativeChatPickerCommands } from '../../../../shared/native-chat-skill-visibility'
import { useNativeChatSkills } from './use-native-chat-skills'
import {
  emitNativeChatPickerItemAccepted,
  emitNativeChatPickerOpened,
  emitNativeChatSendClassified
} from '@/lib/native-chat-telemetry'

export type NativeChatPickerState = {
  autocomplete: ComposerAutocomplete
  listboxId: string
  retrySkills: () => void
  classifySend: (draft: string) => NativeChatSendClassification
  clearSkillOrigin: () => void
  /** The draft still leads with the skill the user picked from the menu. */
  isPickedSkill: (draft: string) => boolean
  completeItem: (item: NativeChatPickerItem) => void
  completeMention: (path: string) => void
  dismiss: (triggerKey: string) => void
  handleDraftOrCaretChange: (value: string, caret: number) => void
}

export function useNativeChatPickerState(args: {
  agent: AgentType
  terminalTabId: string
  draftScopeKey: string
  draft: string
  caret: number
  agentCommands: readonly SlashCommandSuggestion[]
  /** A message recalled from history is resent or walked past, not completed, until it is edited. */
  recalledFromHistory: boolean
  disabled: boolean
  isComposing: () => boolean
  /** Skill names the running session reports; undefined keeps the host disk scan. */
  commandAvailable?: (name: string) => boolean
  sessionSkills?: readonly NativeChatSessionSkill[]
  /** Refresh host catalogs on every / or $ menu opening, even in resting chats. */
  onPickerOpened?: () => void
  textareaRef: RefObject<NativeChatComposerInput | null>
  setDraft: (value: string) => void
  setCaret: Dispatch<SetStateAction<number>>
  setActiveSuggestion: Dispatch<SetStateAction<number>>
}): NativeChatPickerState {
  const {
    agent,
    terminalTabId,
    draftScopeKey,
    draft,
    caret,
    agentCommands,
    recalledFromHistory,
    disabled,
    isComposing,
    sessionSkills,
    commandAvailable,
    onPickerOpened,
    textareaRef,
    setDraft,
    setCaret,
    setActiveSuggestion
  } = args
  const profile = useMemo(() => getNativeChatAgentProfile(agent), [agent])
  const disabledRef = useRef(disabled)
  useLayoutEffect(() => {
    disabledRef.current = disabled
  }, [disabled])
  const skillPickerTriggered = !disabled && isSkillPickerTriggered(draft.slice(0, caret), profile)
  const discovery = useNativeChatSkills(agent, terminalTabId, skillPickerTriggered)
  const pickerCommands = useMemo(
    () => nativeChatPickerCommands(agent, agentCommands, discovery.skills),
    [agent, agentCommands, discovery.skills]
  )
  const listboxId = `native-chat-picker-${useId().replaceAll(':', '')}`
  const dismissalContext = `${draftScopeKey}:${agent}`
  const [dismissed, setDismissed] = useState<{ context: string; triggerKey: string } | null>(null)
  const skillOriginRef = useRef<string | null>(null)
  const lastOpenKeyRef = useRef<string | null>(null)
  const autocomplete = useMemo<ComposerAutocomplete>(
    () =>
      recalledFromHistory || disabled
        ? { mode: 'none' }
        : deriveComposerAutocomplete(
            draft,
            caret,
            pickerCommands,
            discovery.skills,
            profile,
            discovery,
            dismissed?.context === dismissalContext ? dismissed.triggerKey : null,
            sessionSkills,
            commandAvailable
          ),
    [
      caret,
      dismissalContext,
      dismissed,
      discovery,
      disabled,
      draft,
      pickerCommands,
      profile,
      recalledFromHistory,
      sessionSkills,
      commandAvailable
    ]
  )

  useEffect(() => {
    // Reset dismissal/origin on context changes so a reused composer cannot retain a prior pane’s suppression.
    skillOriginRef.current = null
    setDismissed(null)
  }, [dismissalContext])

  useEffect(() => {
    if (autocomplete.mode !== 'slash') {
      lastOpenKeyRef.current = null
      return
    }
    const openKey = `${dismissalContext}:${autocomplete.triggerKey}`
    if (lastOpenKeyRef.current !== openKey) {
      lastOpenKeyRef.current = openKey
      emitNativeChatPickerOpened({ agent, prefix: autocomplete.prefix })
      onPickerOpened?.()
    }
  }, [agent, autocomplete, dismissalContext, onPickerOpened])

  // The editor may be ahead of this render when a key lands just before the pick.
  const liveDraft = useCallback((): [string, number] => {
    const input = textareaRef.current
    return input ? [input.value, input.selectionStart ?? input.value.length] : [draft, caret]
  }, [caret, draft, textareaRef])

  const commitCompletion = useCallback(
    (result: { draft: string; caret: number }) => {
      const textarea = textareaRef.current
      // Mark the draft dirty before the suppressed transaction saves its chip document.
      setDraft(result.draft)
      // An IME composition owns the field; the draft reaches it once the composition settles.
      if (textarea && !isComposing()) {
        writeNativeChatComposerText(textarea, result.draft, result.caret)
      }
      setCaret(result.caret)
      setActiveSuggestion(0)
      setDismissed(null)
    },
    [isComposing, setActiveSuggestion, setCaret, setDraft, textareaRef]
  )

  const completeItem = useCallback(
    (item: NativeChatPickerItem) => {
      if (disabledRef.current || autocomplete.mode !== 'slash') {
        return
      }
      const [text, at] = liveDraft()
      const result = applyPickerSuggestion(text, at, item)
      if (item.kind === 'skill' && textareaRef.current?.insertSkill) {
        const from = result.caret - result.insertedToken.length - 1
        textareaRef.current.insertSkill(from, at, result.insertedToken, item.path)
      }
      commitCompletion(result)
      skillOriginRef.current = item.kind === 'skill' ? result.insertedToken : null
      emitNativeChatPickerItemAccepted({ agent, itemKind: item.kind })
    },
    [agent, autocomplete, commitCompletion, liveDraft, textareaRef]
  )

  const completeMention = useCallback(
    (path: string) => {
      if (disabledRef.current || autocomplete.mode !== 'mention') {
        return
      }
      commitCompletion(applyMentionSuggestion(...liveDraft(), path))
    },
    [autocomplete, commitCompletion, liveDraft]
  )

  const handleDraftOrCaretChange = useCallback(
    (value: string, nextCaret: number) => {
      const firstToken = value.split(/\s/, 1)[0] ?? ''
      if (skillOriginRef.current && firstToken !== skillOriginRef.current) {
        skillOriginRef.current = null
      }
      if (!dismissed || dismissed.context !== dismissalContext) {
        return
      }
      // Whole-token replacement starts a new trigger even at the same position (select-all/paste).
      if (editReplacesTriggerToken(draft, value, dismissed.triggerKey)) {
        setDismissed(null)
        return
      }
      const next = deriveComposerAutocomplete(
        value,
        nextCaret,
        pickerCommands,
        discovery.skills,
        profile,
        discovery,
        null,
        sessionSkills,
        commandAvailable
      )
      if (next.mode === 'none' || next.triggerKey !== dismissed.triggerKey) {
        setDismissed(null)
      }
    },
    [
      dismissalContext,
      dismissed,
      discovery,
      draft,
      pickerCommands,
      profile,
      sessionSkills,
      commandAvailable
    ]
  )

  const classifySend = useCallback(
    (value: string) => {
      const outcome = classifyNativeChatSend(
        value,
        agentCommands,
        skillOriginRef.current,
        profile?.skillPrefix ?? null
      )
      emitNativeChatSendClassified({ agent, outcome })
      return outcome
    },
    [agent, agentCommands, profile]
  )
  const clearSkillOrigin = useCallback(() => {
    skillOriginRef.current = null
  }, [])
  const isPickedSkill = useCallback(
    (value: string) => skillOriginRef.current === (value.split(/\s/, 1)[0] ?? ''),
    []
  )
  const dismiss = useCallback(
    (triggerKey: string) => setDismissed({ context: dismissalContext, triggerKey }),
    [dismissalContext]
  )

  return {
    autocomplete,
    listboxId,
    retrySkills: discovery.retry,
    classifySend,
    clearSkillOrigin,
    isPickedSkill,
    completeItem,
    completeMention,
    dismiss,
    handleDraftOrCaretChange
  }
}
