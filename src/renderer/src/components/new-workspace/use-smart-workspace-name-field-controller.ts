import { useEffect, useMemo } from 'react'
import {
  getActiveWorkspaceEmojiShortcode,
  searchWorkspaceEmojiShortcodes,
  type WorkspaceEmojiSuggestion
} from '@/lib/workspace-emoji-shortcodes'
import type { SmartWorkspaceNameFieldProps } from './smart-workspace-name-field-model'
import { useWorkItemSourceSearch } from './use-work-item-source-search'
import { useSmartWorkspaceFieldFocusControls } from './use-smart-workspace-field-focus-controls'
import { useSmartWorkspaceNameFieldActions } from './use-smart-workspace-name-field-actions'
import { getSmartWorkspaceNameFieldCopy } from './smart-workspace-name-field-copy'

export function useSmartWorkspaceNameFieldController(props: SmartWorkspaceNameFieldProps) {
  const search = useWorkItemSourceSearch({
    ...props,
    typedTextEnabled: true,
    sourceSelected: props.selectedSource !== null,
    gitlabEnabled: Boolean(props.onGitLabItemSelect)
  })
  const focus = useSmartWorkspaceFieldFocusControls({
    props: {
      selectedSource: props.selectedSource,
      inputRef: props.inputRef,
      disabled: search.disabled
    },
    state: search
  })
  const { value, selectedSource, disabled = false, onActiveSourceModeChange } = props
  const { mode: sourceMode } = search
  const { emojiCursor, emojiCommandValue } = focus
  const activeEmojiShortcode = useMemo(
    () => getActiveWorkspaceEmojiShortcode(value, emojiCursor),
    [emojiCursor, value]
  )
  const emojiSuggestions: WorkspaceEmojiSuggestion[] = useMemo(
    () => (activeEmojiShortcode ? searchWorkspaceEmojiShortcodes(activeEmojiShortcode.query) : []),
    [activeEmojiShortcode]
  )
  const emojiMenuOpen =
    !disabled &&
    selectedSource === null &&
    activeEmojiShortcode !== null &&
    emojiSuggestions.length > 0
  const resolvedEmojiCommandValue = emojiSuggestions.some(
    (suggestion) => `emoji:${suggestion.shortcode}` === emojiCommandValue
  )
    ? emojiCommandValue
    : emojiSuggestions[0]
      ? `emoji:${emojiSuggestions[0].shortcode}`
      : ''
  const selectedEmojiSuggestion =
    emojiSuggestions.find(
      (suggestion) => `emoji:${suggestion.shortcode}` === resolvedEmojiCommandValue
    ) ?? null
  useEffect(() => {
    onActiveSourceModeChange?.(sourceMode)
  }, [sourceMode, onActiveSourceModeChange])
  const handleModeChange = (mode: typeof search.mode): void => {
    search.setMode(mode)
    if (!search.disabled && mode !== 'text' && selectedSource === null) {
      focus.markSourcePopoverUserEngaged()
      focus.setOpen(true)
    } else {
      focus.setOpen(false)
    }
    focus.cancelLocalInputFocusFrame()
    focus.localInputFocusFrameRef.current = requestAnimationFrame(() => {
      focus.localInputFocusFrameRef.current = null
      focus.localInputRef.current?.focus({ preventScroll: true })
    })
  }
  const foundation = {
    ...props,
    ...search,
    ...focus,
    allowCrossRepoProjectAdd: props.allowCrossRepoProjectAdd ?? true
  }
  const actions = useSmartWorkspaceNameFieldActions(foundation, { ...search, activeEmojiShortcode })
  const copy = getSmartWorkspaceNameFieldCopy({
    ...search,
    disabledPlaceholder: props.disabledPlaceholder
  })
  return {
    ...foundation,
    ...actions,
    ...copy,
    handleModeChange,
    activeEmojiShortcode,
    emojiSuggestions,
    emojiMenuOpen,
    resolvedEmojiCommandValue,
    selectedEmojiSuggestion,
    open: focus.open && !search.crossRepoPrompt && !search.disabled && search.mode !== 'text'
  }
}
export type SmartWorkspaceNameFieldController = ReturnType<
  typeof useSmartWorkspaceNameFieldController
>
