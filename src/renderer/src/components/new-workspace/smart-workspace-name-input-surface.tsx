import React from 'react'
import { ExternalLink, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { isImeCompositionKeyDown } from '@/lib/ime-composition-keyboard-event'
import { isBlockingJiraUrlIntent } from './smart-workspace-source-results'
import { isBlockingLinearUrlIntent } from '../../../../shared/new-workspace/smart-workspace-linear-intent'
import { isComposerFieldToFieldFocus } from './smart-workspace-source-popover-focus'
import { replaceCompletedWorkspaceEmojiShortcode } from '@/lib/workspace-emoji-shortcodes'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { SelectionIcon } from './smart-workspace-source-row-content'
import type { SmartWorkspaceNameFieldController } from './use-smart-workspace-name-field-controller'

export function renderSmartWorkspaceNameInput(
  controller: SmartWorkspaceNameFieldController
): React.JSX.Element {
  const {
    selectedSource,
    setSelectedSourceNode,
    onClearSelectedSource,
    cancelLocalInputFocusFrame,
    localInputFocusFrameRef,
    localInputRef,
    openSelectedSource,
    onPlainEnter,
    ActiveInputIcon,
    showSearchSpinner,
    mode,
    setInputNode,
    value,
    disabled,
    markSourcePopoverUserEngaged,
    setOpen,
    setEmojiCursor,
    applyEmojiReplacement,
    onValueChange,
    tryOpenSourcePopover,
    tabsListRef,
    emojiMenuOpen,
    emojiSuggestions,
    resolvedEmojiCommandValue,
    setEmojiCommandValue,
    selectedEmojiSuggestion,
    handleEmojiSelect,
    open,
    rows,
    resolvedCommandValue,
    handleSelect,
    jiraSource,
    placeholder,
    jiraStatusId,
    linearStatusId,
    unresolvedLinearUrlIntent,
    blockingTaskUrlResolution
  } = controller

  if (selectedSource) {
    return (
      // Why: min-w-0 + w-full let long source titles shrink inside the dialog.
      <div
        ref={setSelectedSourceNode}
        data-workspace-source-pill="true"
        tabIndex={0}
        aria-keyshortcuts={selectedSource.url ? 'Alt+Enter Backspace Delete' : 'Backspace Delete'}
        onKeyDown={(event) => {
          if (event.currentTarget !== event.target) {
            return
          }
          if (
            (event.key === 'Backspace' || event.key === 'Delete') &&
            !event.metaKey &&
            !event.ctrlKey &&
            !event.shiftKey &&
            !event.altKey
          ) {
            event.preventDefault()
            onClearSelectedSource()
            cancelLocalInputFocusFrame()
            localInputFocusFrameRef.current = requestAnimationFrame(() => {
              localInputFocusFrameRef.current = null
              localInputRef.current?.focus({ preventScroll: true })
            })
            return
          }
          if (
            event.key === 'Enter' &&
            event.altKey &&
            !event.metaKey &&
            !event.ctrlKey &&
            !event.shiftKey &&
            selectedSource.url
          ) {
            event.preventDefault()
            openSelectedSource()
            return
          }
          if (
            event.key !== 'Enter' ||
            event.metaKey ||
            event.ctrlKey ||
            event.shiftKey ||
            event.altKey
          ) {
            return
          }
          event.preventDefault()
          onPlainEnter?.()
        }}
        className="flex h-9 w-full min-w-0 items-center gap-2 rounded-md border border-input bg-background px-2.5 text-sm shadow-xs outline-none focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50 dark:bg-input/30"
      >
        <SelectionIcon kind={selectedSource.kind} />
        <span className="min-w-0 flex-1 truncate font-medium leading-none text-foreground">
          {selectedSource.label}
        </span>
        {selectedSource.url ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                tabIndex={-1}
                onClick={openSelectedSource}
                className="size-6 shrink-0 rounded-sm text-muted-foreground hover:text-foreground"
                aria-label={translate(
                  'auto.components.new.workspace.SmartWorkspaceNameField.2c69728c2a',
                  'Open link in browser'
                )}
              >
                <ExternalLink className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={6}>
              {translate(
                'auto.components.new.workspace.SmartWorkspaceNameField.370a1faf67',
                'Open in browser'
              )}
            </TooltipContent>
          </Tooltip>
        ) : null}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              tabIndex={-1}
              onClick={onClearSelectedSource}
              className="size-6 shrink-0 rounded-sm text-muted-foreground hover:text-foreground"
              aria-label={translate(
                'auto.components.new.workspace.SmartWorkspaceNameField.7199ff19c7',
                'Clear selected source'
              )}
            >
              <X className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={6}>
            {translate('auto.components.new.workspace.SmartWorkspaceNameField.0c9e668e3a', 'Clear')}
          </TooltipContent>
        </Tooltip>
      </div>
    )
  }

  return (
    <>
      <ActiveInputIcon
        className={cn(
          'pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground',
          showSearchSpinner && mode !== 'text' && 'animate-spin'
        )}
      />
      <Input
        ref={setInputNode}
        data-workspace-name-input="true"
        value={value}
        onPointerDown={() => {
          if (!disabled && mode !== 'text') {
            markSourcePopoverUserEngaged()
            setOpen(true)
          }
        }}
        onClick={(event) => setEmojiCursor(event.currentTarget.selectionStart)}
        onChange={(event) => {
          const nextValue = event.target.value
          const nextCursor = event.target.selectionStart
          const completedEmoji = replaceCompletedWorkspaceEmojiShortcode(nextValue, nextCursor)
          if (completedEmoji) {
            applyEmojiReplacement(completedEmoji)
            return
          }
          onValueChange(nextValue)
          setEmojiCursor(nextCursor)
          if (!disabled && mode !== 'text') {
            markSourcePopoverUserEngaged()
            setOpen(true)
          }
        }}
        onPaste={(event) => {
          // Why: a pasted issue URL is the whole intent, not a name fragment.
          const pasted = event.clipboardData.getData('text')
          if (
            !pasted ||
            (!isBlockingJiraUrlIntent(mode, pasted) && !isBlockingLinearUrlIntent(mode, pasted))
          ) {
            return
          }
          event.preventDefault()
          onValueChange(pasted)
          if (!disabled && mode !== 'text') {
            markSourcePopoverUserEngaged()
            setOpen(true)
          }
        }}
        onFocus={(event) => {
          // Why: dialog autofocus stays suppressed; only field-to-field focus opens results.
          if (!isComposerFieldToFieldFocus(event)) {
            setEmojiCursor(event.currentTarget.selectionStart)
            return
          }
          setEmojiCursor(event.currentTarget.selectionStart)
          markSourcePopoverUserEngaged()
          tryOpenSourcePopover()
        }}
        onKeyDown={(event) => {
          if (event.key === 'Tab' && event.shiftKey) {
            const activeTrigger = tabsListRef.current?.querySelector<HTMLElement>(
              `[data-smart-name-mode="${mode}"]`
            )
            if (activeTrigger) {
              event.preventDefault()
              activeTrigger.focus()
              return
            }
          }
          if (emojiMenuOpen && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
            event.preventDefault()
            event.stopPropagation()
            const selectedIndex = emojiSuggestions.findIndex(
              (suggestion) => `emoji:${suggestion.shortcode}` === resolvedEmojiCommandValue
            )
            const direction = event.key === 'ArrowDown' ? 1 : -1
            const nextIndex =
              (selectedIndex + direction + emojiSuggestions.length) % emojiSuggestions.length
            setEmojiCommandValue(`emoji:${emojiSuggestions[nextIndex].shortcode}`)
            return
          }
          if (event.key === 'Enter' && !event.metaKey && !event.ctrlKey && !event.shiftKey) {
            // Why: committing an IME candidate must not select a row or move focus.
            if (isImeCompositionKeyDown(event)) {
              return
            }
            if (emojiMenuOpen && selectedEmojiSuggestion) {
              event.preventDefault()
              event.stopPropagation()
              handleEmojiSelect(selectedEmojiSuggestion)
              return
            }
            if (unresolvedLinearUrlIntent || blockingTaskUrlResolution) {
              event.preventDefault()
              return
            }
            if (open && rows.length > 0) {
              const row = rows.find((entry) => entry.value === resolvedCommandValue)
              if (row) {
                event.preventDefault()
                handleSelect(row)
                return
              }
            }
            if (mode === 'jira' || jiraSource.intent) {
              event.preventDefault()
              return
            }
            onPlainEnter?.()
          }
          if (event.key === 'Tab' && !event.shiftKey && emojiMenuOpen && selectedEmojiSuggestion) {
            event.preventDefault()
            event.stopPropagation()
            handleEmojiSelect(selectedEmojiSuggestion)
            return
          }
          if (event.key === 'Escape' && emojiMenuOpen) {
            event.stopPropagation()
            setEmojiCursor(null)
            return
          }
          if (event.key === 'Escape' && open) {
            event.stopPropagation()
            setOpen(false)
          }
        }}
        placeholder={placeholder}
        disabled={disabled}
        aria-busy={(jiraSource.intent && jiraSource.loading) || unresolvedLinearUrlIntent}
        aria-describedby={
          jiraSource.intent ? jiraStatusId : unresolvedLinearUrlIntent ? linearStatusId : undefined
        }
        // Why: match adjacent comboboxes' solid background in light mode.
        className="h-9 bg-background pl-8 text-sm"
      />
    </>
  )
}
