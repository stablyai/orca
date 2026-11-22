import { useNativeChatPickerContext } from './use-native-chat-picker-context'
import {
  applyNativeChatMention as applyMention,
  writeNativeChatComposerText,
  type NativeChatComposerInput
} from '../editor/native-chat-composer-input'
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  type Dispatch,
  type RefObject,
  type SetStateAction
} from 'react'
import type { AgentType } from '../../../../../../shared/agent-status/contracts/agent-status-types'
import { getNativeChatAgentProfile } from '../../../../../../shared/native-chat/input/commands/native-chat-agent-profiles'

import {
  deriveComposerAutocomplete,
  editReplacesTriggerToken,
  isSkillPickerTriggered,
  type ComposerAutocomplete
} from '../../../../../../shared/native-chat/input/composer/native-chat-composer-autocomplete'
import { applyPickerSuggestion } from '../../../../../../shared/native-chat/input/composer/native-chat-picker-triggers'
import {
  classifyNativeChatSend,
  type NativeChatSendClassification,
  type NativeChatSessionSkill,
  type SlashCommandSuggestion
} from '../../../../../../shared/native-chat/input/commands/native-chat-slash-commands'
import type { NativeChatPickerItem } from '../../../../../../shared/native-chat/input/composer/native-chat-picker-items'
import { nativeChatPickerCommands } from '../../../../../../shared/native-chat/input/commands/native-chat-skill-visibility'
import { useNativeChatSkills } from './use-native-chat-skills'
import { useNativeChatPreferredSuggestion } from './use-native-chat-preferred-suggestion'
import { useNativeChatPickerDismissal } from './use-native-chat-picker-dismissal'
import {
  emitNativeChatPickerItemAccepted,
  emitNativeChatPickerOpened,
  emitNativeChatSendClassified
} from '@/components/native-chat/telemetry/native-chat-telemetry'

export type NativeChatPickerState = {
  autocomplete: ComposerAutocomplete
  listboxId: string
  retrySkills: () => void
  classifySend: (draft: string) => NativeChatSendClassification
  clearSkillOrigin: () => void
  /** The draft still leads with the skill the user picked from the menu. */
  isPickedSkill: (draft: string) => boolean
  completeItem: (item: NativeChatPickerItem) => void
  /** `token` replaces the file-reference form, e.g. a room's `@Name`; with `from`, it replaces
   *  `from` to the caret wherever the menu is (a bot's chats filter on text with spaces). */
  completeMention: (path: string, token?: Parameters<typeof applyMention>[4], from?: number) => void
  dismiss: (triggerKey: string) => void
  handleDraftOrCaretChange: (value: string, caret: number) => void
  /** Arrow-key highlight moves; a catalog refresh keeps the row they land on until the next edit. */
  navigateSuggestion: Dispatch<SetStateAction<number>>
}

export function useNativeChatPickerState(args: {
  agent: AgentType
  terminalTabId: string
  /** A launch panel's workspace, whose skills it lists before any tab exists. */
  launchWorktreeId?: string
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
  /** A room's `@` query may hold spaces while this says a pickable member's name still matches. */
  mentionNameMatches?: (query: string) => boolean
  /** Refresh host catalogs on every / or $ menu opening, even in resting chats. */
  onPickerOpened?: () => void
  onPickerDemand?: (open: boolean) => void
  skillsChecking?: boolean
  textareaRef: RefObject<NativeChatComposerInput | null>
  setDraft: (value: string) => void
  setCaret: Dispatch<SetStateAction<number>>
  setActiveSuggestion: Dispatch<SetStateAction<number>>
}): NativeChatPickerState {
  const {
    agent,
    terminalTabId,
    launchWorktreeId,
    draftScopeKey,
    draft,
    caret,
    agentCommands,
    recalledFromHistory,
    disabled,
    isComposing,
    sessionSkills,
    commandAvailable,
    mentionNameMatches,
    onPickerOpened,
    onPickerDemand,
    skillsChecking = false,
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
  const discovery = useNativeChatSkills(
    agent,
    terminalTabId,
    skillPickerTriggered,
    launchWorktreeId
  )
  const pickerCommands = useMemo(
    () => nativeChatPickerCommands(agent, agentCommands, discovery.skills),
    [agent, agentCommands, discovery.skills]
  )
  const listboxId = `native-chat-picker-${useId().replaceAll(':', '')}`
  const dismissalContext = `${draftScopeKey}:${agent}`
  const {
    dismissed,
    dismiss,
    clear: clearDismissed,
    handleMentionChange
  } = useNativeChatPickerDismissal(dismissalContext, textareaRef)
  const skillOriginRef = useRef<string | null>(null)
  useNativeChatPickerContext(dismissalContext, () => {
    skillOriginRef.current = null
  })
  const lastOpenKeyRef = useRef<string | null>(null)
  const derive = useCallback(
    (value: string, at: number, dismissedTriggerKey: string | null) =>
      deriveComposerAutocomplete(
        value,
        at,
        pickerCommands,
        discovery.skills,
        profile,
        discovery,
        dismissedTriggerKey,
        sessionSkills,
        commandAvailable,
        mentionNameMatches
      ),
    [discovery, pickerCommands, profile, sessionSkills, commandAvailable, mentionNameMatches]
  )
  const derivedAutocomplete = useMemo<ComposerAutocomplete>(
    () =>
      recalledFromHistory || disabled
        ? { mode: 'none' }
        : derive(
            draft,
            caret,
            dismissed?.context === dismissalContext ? dismissed.triggerKey : null
          ),
    [caret, derive, dismissalContext, dismissed, disabled, draft, recalledFromHistory]
  )
  const autocomplete = useMemo(
    () =>
      skillsChecking && derivedAutocomplete.mode === 'slash'
        ? { ...derivedAutocomplete, skillsChecking }
        : derivedAutocomplete,
    [derivedAutocomplete, skillsChecking]
  )
  const navigateSuggestion = useNativeChatPreferredSuggestion(
    autocomplete,
    draft,
    caret,
    setActiveSuggestion
  )

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

  const menuOpen = autocomplete.mode === 'slash'
  useEffect(() => {
    onPickerDemand?.(menuOpen)
    return () => onPickerDemand?.(false)
  }, [dismissalContext, menuOpen, onPickerDemand])

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
      clearDismissed()
    },
    [clearDismissed, isComposing, setActiveSuggestion, setCaret, setDraft, textareaRef]
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
    (path: string, token?: Parameters<typeof applyMention>[4], from?: number) => {
      if (!disabledRef.current && (from !== undefined || autocomplete.mode === 'mention')) {
        commitCompletion(
          applyMention(textareaRef.current, ...liveDraft(), path, token, from, mentionNameMatches)
        )
      }
    },
    [autocomplete, commitCompletion, liveDraft, mentionNameMatches, textareaRef]
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
      if (handleMentionChange(value, dismissed.triggerKey)) {
        return
      }
      // Whole-token replacement starts a new trigger even at the same position (select-all/paste).
      if (editReplacesTriggerToken(draft, value, dismissed.triggerKey)) {
        clearDismissed()
        return
      }
      const next = derive(value, nextCaret, null)
      if (next.mode === 'none' || next.triggerKey !== dismissed.triggerKey) {
        clearDismissed()
      }
    },
    [clearDismissed, derive, dismissalContext, dismissed, draft, handleMentionChange]
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
    handleDraftOrCaretChange,
    navigateSuggestion
  }
}
