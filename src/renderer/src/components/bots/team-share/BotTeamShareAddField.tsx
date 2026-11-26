// The Add field of an agent's people list: picks wait in it as chips, and what it finds opens under it.
import { useId, useState } from 'react'
import { Input } from '@/components/ui/input'
import { MENU_SURFACE_CLASS } from '@/components/ui/menu-surface'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import type { TeamShareSuggestion } from './bot-team-share-people'
import { TeamShareNoMatch, TeamShareSuggestionOption } from './BotTeamShareRows'
import { TeamShareStagedChip } from './BotTeamShareStagedChip'
import type { BotTeamShareList } from './use-bot-team-share-list'

export function TeamShareAddField({
  query,
  onQueryChange,
  suggestions,
  staged,
  onStage,
  onUnstage,
  inputRef,
  focusedOnOpen = false
}: Pick<
  BotTeamShareList,
  'query' | 'onQueryChange' | 'suggestions' | 'staged' | 'onStage' | 'onUnstage'
> & {
  inputRef?: React.Ref<HTMLInputElement>
  /** The caller focuses the field as it opens, so suggestions show from the first keystroke. */
  focusedOnOpen?: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const listId = useId()
  const [activeIndex, setActiveIndex] = useState(0)
  // Leaving the field hides the suggestions until it is back.
  const [focused, setFocused] = useState(focusedOnOpen)
  const open = focused && query.trim() !== '' && suggestions !== null
  const shown = open ? suggestions : []
  const listed = shown.length > 0
  const active = shown.length > 0 ? Math.min(activeIndex, shown.length - 1) : -1
  const optionId = (index: number) => `${listId}-${index}`
  const pick = (suggestion: TeamShareSuggestion | undefined) => {
    if (suggestion) {
      onStage(suggestion)
      setActiveIndex(0)
    }
  }
  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    const last = staged.at(-1)
    if (event.key === 'Backspace' && query === '' && last) {
      event.preventDefault()
      onUnstage(last)
      return
    }
    if (shown.length === 0) {
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const step = event.key === 'ArrowDown' ? 1 : -1
      const next = (active + step + shown.length) % shown.length
      setActiveIndex(next)
      // Focus stays in the field, so the list follows the keyboard pick itself.
      document.getElementById(optionId(next))?.scrollIntoView({ block: 'nearest' })
    } else if (event.key === 'Enter') {
      event.preventDefault()
      pick(shown[active])
    }
  }
  return (
    <div
      className="relative min-w-0 flex-1"
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          setFocused(false)
        }
      }}
    >
      {/* A drawn field: the chips sit inside it, so the input is the embedded text run. */}
      <div
        className="scrollbar-sleek flex max-h-24 min-h-9 flex-wrap items-center gap-1 overflow-y-auto rounded-md border border-input px-3 py-1 shadow-xs transition-[color,box-shadow] focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50 dark:bg-input/30"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) {
            event.preventDefault()
            event.currentTarget.querySelector('input')?.focus()
          }
        }}
      >
        {staged.map((suggestion) => (
          <TeamShareStagedChip
            key={suggestion.key}
            suggestion={suggestion}
            onRemove={() => onUnstage(suggestion)}
          />
        ))}
        <Input
          ref={inputRef}
          surface="embedded"
          className="h-7 w-auto min-w-24 flex-1"
          role="combobox"
          aria-expanded={listed}
          aria-controls={listed ? listId : undefined}
          aria-autocomplete="list"
          aria-activedescendant={active >= 0 ? optionId(active) : undefined}
          aria-label={t('bots.teamShare.addLabel', 'Add people')}
          autoComplete="off"
          spellCheck={false}
          placeholder={
            staged.length === 0
              ? t('bots.teamShare.addPlaceholder', 'Email, Slack @name or GitHub login')
              : undefined
          }
          value={query}
          onChange={(event) => {
            onQueryChange(event.target.value)
            setActiveIndex(0)
          }}
          onKeyDown={onKeyDown}
        />
      </div>
      {open ? (
        <div
          id={listed ? listId : undefined}
          role={listed ? 'listbox' : undefined}
          aria-label={listed ? t('bots.teamShare.suggestions', 'Suggestions') : undefined}
          // Keep focus in the field, so a press on the list or its scrollbar doesn't close it.
          onMouseDown={(event) => event.preventDefault()}
          className={cn(
            MENU_SURFACE_CLASS,
            'absolute inset-x-0 top-full z-10 mt-1 max-h-[min(20rem,50dvh)] overflow-y-auto scrollbar-sleek'
          )}
        >
          {listed ? (
            shown.map((suggestion, index) => (
              <TeamShareSuggestionOption
                key={suggestion.key}
                id={optionId(index)}
                suggestion={suggestion}
                active={index === active}
                onPick={() => pick(suggestion)}
                onHover={() => setActiveIndex(index)}
              />
            ))
          ) : (
            <TeamShareNoMatch query={query.trim()} />
          )}
        </div>
      ) : null}
    </div>
  )
}
