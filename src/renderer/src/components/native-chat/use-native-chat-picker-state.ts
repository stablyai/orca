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
  applyPickerSuggestion,
  classifyNativeChatSend,
  deriveComposerAutocomplete,
  editReplacesTriggerToken,
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
  textareaRef: RefObject<HTMLTextAreaElement | null>
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
    textareaRef,
    setDraft,
    setCaret,
    setActiveSuggestion
  } = args
  const profile = useMemo(() => getNativeChatAgentProfile(agent), [agent])
  const beforeCaret = draft.slice(0, caret)
  const skillPickerTriggered =
    profile?.skillPrefix === '$'
      ? /(?:^|\s)\$\S*$/.test(beforeCaret)
      : profile?.skillPrefix === '/'
        ? beforeCaret.startsWith('/') && !/\s/.test(beforeCaret)
        : false
  const discovery = useNativeChatSkills(agent, terminalTabId, skillPickerTriggered)
  const listboxId = `native-chat-picker-${useId().replaceAll(':', '')}`
  const dismissalContext = `${draftScopeKey}:${agent}`
  const [dismissed, setDismissed] = useState<{ context: string; triggerKey: string } | null>(null)
  const skillOriginRef = useRef<string | null>(null)
  const lastOpenKeyRef = useRef<string | null>(null)
  const autocomplete = useMemo(
    () =>
      deriveComposerAutocomplete(
        draft,
        caret,
        agentCommands,
        discovery.skills,
        profile,
        discovery,
        dismissed?.context === dismissalContext ? dismissed.triggerKey : null
      ),
    [agentCommands, caret, dismissalContext, dismissed, discovery, draft, profile]
  )

  useEffect(() => {
    // Why: suppression is per-trigger-occurrence AND per-context. The composer
    // is reused across pane/agent switches, so a stale dismissal must clear or
    // the picker stays closed for an in-progress token when that context returns.
    skillOriginRef.current = null
    setDismissed(null)
  }, [dismissalContext])

  useEffect(() => {
    if (autocomplete.mode !== 'slash' && autocomplete.mode !== 'skill') {
      lastOpenKeyRef.current = null
      return
    }
    const openKey = `${dismissalContext}:${autocomplete.triggerKey}`
    if (lastOpenKeyRef.current !== openKey) {
      lastOpenKeyRef.current = openKey
      emitNativeChatPickerOpened({ agent, prefix: autocomplete.prefix })
    }
  }, [agent, autocomplete, dismissalContext])

  const completeItem = useCallback(
    (item: NativeChatPickerItem) => {
      if (autocomplete.mode !== 'slash' && autocomplete.mode !== 'skill') {
        return
      }
      const result = applyPickerSuggestion(draft, caret, item, autocomplete.prefix)
      setDraft(result.draft)
      setCaret(result.caret)
      setActiveSuggestion(0)
      setDismissed(null)
      skillOriginRef.current = item.kind === 'skill' ? result.insertedToken : null
      emitNativeChatPickerItemAccepted({ agent, itemKind: item.kind })
      const textarea = textareaRef.current
      textarea?.focus()
      requestAnimationFrame(() => textarea?.setSelectionRange(result.caret, result.caret))
    },
    [agent, autocomplete, caret, draft, setActiveSuggestion, setCaret, setDraft, textareaRef]
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
        discovery
      )
      if (
        (next.mode !== 'slash' && next.mode !== 'skill') ||
        next.triggerKey !== dismissed.triggerKey
      ) {
        setDismissed(null)
      }
    },
    [agentCommands, dismissalContext, dismissed, discovery, draft, profile]
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
    dismiss,
    handleDraftOrCaretChange
  }
}
