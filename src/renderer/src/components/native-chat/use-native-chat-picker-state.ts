import type { NativeChatComposerInput } from './native-chat-composer-input'
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction
} from 'react'
import type { AgentType } from '../../../../shared/agent-status-types'
import { getNativeChatAgentProfile } from '../../../../shared/native-chat-agent-profiles'
import type { SlashCommandSuggestion } from '../../../../shared/native-chat-slash-commands'
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
} from './native-chat-composer-state'
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
  /** Skill names the running session reports; undefined keeps the host disk scan. */
  sessionSkillNames?: readonly string[]
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
    sessionSkillNames,
    textareaRef,
    setDraft,
    setCaret,
    setActiveSuggestion
  } = args
  const profile = useMemo(() => getNativeChatAgentProfile(agent), [agent])
  const skillPickerTriggered = isSkillPickerTriggered(draft.slice(0, caret), profile)
  const discovery = useNativeChatSkills(agent, terminalTabId, skillPickerTriggered)
  const listboxId = `native-chat-picker-${useId().replaceAll(':', '')}`
  const dismissalContext = `${draftScopeKey}:${agent}`
  const [dismissed, setDismissed] = useState<{ context: string; triggerKey: string } | null>(null)
  const skillOriginRef = useRef<string | null>(null)
  const lastOpenKeyRef = useRef<string | null>(null)
  const autocomplete = useMemo<ComposerAutocomplete>(
    () =>
      recalledFromHistory
        ? { mode: 'none' }
        : deriveComposerAutocomplete(
            draft,
            caret,
            agentCommands,
            discovery.skills,
            profile,
            discovery,
            dismissed?.context === dismissalContext ? dismissed.triggerKey : null,
            sessionSkillNames
          ),
    [
      agentCommands,
      caret,
      dismissalContext,
      dismissed,
      discovery,
      draft,
      profile,
      recalledFromHistory,
      sessionSkillNames
    ]
  )

  useEffect(() => {
    // Why: suppression is per-trigger-occurrence AND per-context. The composer
    // is reused across pane/agent switches, so a stale dismissal must clear or
    // the picker stays closed for an in-progress token when that context returns.
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
    }
  }, [agent, autocomplete, dismissalContext])

  const commitCompletion = useCallback(
    (result: { draft: string; caret: number }) => {
      setDraft(result.draft)
      setCaret(result.caret)
      setActiveSuggestion(0)
      setDismissed(null)
      const textarea = textareaRef.current
      textarea?.focus()
      requestAnimationFrame(() => textarea?.setSelectionRange(result.caret, result.caret))
    },
    [setActiveSuggestion, setCaret, setDraft, textareaRef]
  )

  const completeItem = useCallback(
    (item: NativeChatPickerItem) => {
      if (autocomplete.mode !== 'slash') {
        return
      }
      const result = applyPickerSuggestion(draft, caret, item)
      if (item.kind === 'skill' && textareaRef.current?.insertSkill) {
        const from = result.caret - result.insertedToken.length - 1
        textareaRef.current.insertSkill(from, caret, result.insertedToken)
      }
      commitCompletion(result)
      skillOriginRef.current = item.kind === 'skill' ? result.insertedToken : null
      emitNativeChatPickerItemAccepted({ agent, itemKind: item.kind })
    },
    [agent, autocomplete, caret, commitCompletion, draft, textareaRef]
  )

  const completeMention = useCallback(
    (path: string) => commitCompletion(applyMentionSuggestion(draft, caret, path)),
    [caret, commitCompletion, draft]
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
      // Why: a single edit that replaces the dismissed token wholesale (e.g.
      // select-all + paste) is a new trigger occurrence even though a trigger
      // character lands back on the same draft position.
      if (editReplacesTriggerToken(draft, value, dismissed.triggerKey)) {
        setDismissed(null)
        return
      }
      const next = deriveComposerAutocomplete(
        value,
        nextCaret,
        agentCommands,
        discovery.skills,
        profile,
        discovery,
        null,
        sessionSkillNames
      )
      if (next.mode === 'none' || next.triggerKey !== dismissed.triggerKey) {
        setDismissed(null)
      }
    },
    [agentCommands, dismissalContext, dismissed, discovery, draft, profile, sessionSkillNames]
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
    completeItem,
    completeMention,
    dismiss,
    handleDraftOrCaretChange
  }
}
