// Share an agent with people: picks wait in the Add field as chips until Share saves them, then
// everyone who can ask it. The caller owns the people, the picks and the search; this draws them.
import { useId, useRef, useState } from 'react'
import { Laptop } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { MENU_SURFACE_CLASS } from '@/components/ui/menu-surface'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import type { Bot } from '../../../../../shared/bot-types'
import { BotAvatar } from '../BotAvatar'
import type { TeamShareOwner, TeamSharePerson, TeamShareSuggestion } from './bot-team-share-people'
import {
  TeamShareNoMatch,
  TeamShareOwnerRow,
  TeamSharePersonRow,
  TeamShareSuggestionOption
} from './BotTeamShareRows'
import { TeamShareStagedChip } from './BotTeamShareStagedChip'

export function BotTeamShareDialog({
  bot,
  hostName,
  owner,
  people,
  query,
  onQueryChange,
  suggestions,
  staged,
  onStage,
  onUnstage,
  onShare,
  onCancelStaged,
  onRemove,
  onResend,
  onShareAgain,
  onClose,
  children
}: {
  bot: Bot
  /** The computer the agent runs on, named in the footer warning. */
  hostName: string
  /** The account the agent's host is signed in as; null while it isn't. */
  owner: TeamShareOwner | null
  people: readonly TeamSharePerson[]
  query: string
  onQueryChange: (query: string) => void
  /** What the field found for `query`; null while it is empty or still searching. */
  suggestions: readonly TeamShareSuggestion[] | null
  /** Picked in the field, not saved until Share. */
  staged: readonly TeamShareSuggestion[]
  onStage: (suggestion: TeamShareSuggestion) => void
  onUnstage: (suggestion: TeamShareSuggestion) => void
  onShare: () => void
  onCancelStaged: () => void
  onRemove: (person: TeamSharePerson) => void
  onResend: (person: Extract<TeamSharePerson, { kind: 'invite' }>) => void
  /** A declined person, asked again under a new share id. */
  onShareAgain: (person: Extract<TeamSharePerson, { kind: 'account' }>) => void
  onClose: () => void
  /** Rows the caller draws itself after `people`: Slack- and GitHub-only people, from Who can ask. */
  children?: React.ReactNode
}): React.JSX.Element {
  const t = useTranslate()
  const listId = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const [activeIndex, setActiveIndex] = useState(0)
  // The field is focused on open; leaving the Add row hides the suggestions until it is back.
  const [addRowFocused, setAddRowFocused] = useState(true)
  const open = addRowFocused && query.trim() !== '' && suggestions !== null
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
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        size="flush"
        className="max-h-[calc(100dvh-2rem)] grid-rows-[auto_auto_minmax(0,1fr)_auto] sm:max-w-[520px]"
        aria-describedby={undefined}
        // The field, not a chip's ✕, takes focus on open.
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          inputRef.current?.focus()
        }}
      >
        <div className="flex items-center gap-3 px-6 pt-6 pr-12">
          <BotAvatar bot={bot} className="size-9 rounded-[9px] text-base" />
          <DialogTitle className="min-w-0">
            <span className="block truncate">
              {t('bots.teamShare.title', 'Share {{name}}', { name: bot.name })}
            </span>
          </DialogTitle>
        </div>
        <div
          className="flex items-center gap-2 px-6 pt-4"
          onFocus={() => setAddRowFocused(true)}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) {
              setAddRowFocused(false)
            }
          }}
        >
          <div className="relative min-w-0 flex-1">
            {/* A drawn field: the chips sit inside it, so the input is the embedded text run. */}
            <div
              className="scrollbar-sleek flex max-h-24 min-h-9 flex-wrap items-center gap-1 overflow-y-auto rounded-md border border-input px-3 py-1 shadow-xs transition-[color,box-shadow] focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50 dark:bg-input/30"
              onMouseDown={(event) => {
                if (event.target === event.currentTarget) {
                  event.preventDefault()
                  inputRef.current?.focus()
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
        </div>
        <div className="scrollbar-sleek min-h-0 max-h-[340px] overflow-y-auto pt-1 pb-2">
          <h3 className="px-6 pt-4 pb-1 text-xs font-medium text-muted-foreground">
            {t('bots.teamShare.peopleWithAccess', 'People with access')}
          </h3>
          <ul>
            {owner ? <TeamShareOwnerRow owner={owner} /> : null}
            {people.map((person) => (
              <TeamSharePersonRow
                key={person.key}
                person={person}
                onRemove={onRemove}
                onResend={onResend}
                onShareAgain={onShareAgain}
              />
            ))}
            {children}
          </ul>
        </div>
        <div className="flex items-center gap-2 border-t border-border px-6 py-4">
          <p className="flex min-w-0 flex-1 items-start gap-1.5 text-xs leading-4 text-muted-foreground">
            <Laptop className="mt-px size-3.5 shrink-0" aria-hidden />
            <span>
              {t(
                'bots.teamShare.warning',
                'Anyone you share with can do anything {{name}} can on {{host}}, including using your accounts, files and chats.',
                { name: bot.name, host: hostName }
              )}
            </span>
          </p>
          {staged.length > 0 ? (
            <>
              <Button variant="ghost" onClick={onCancelStaged}>
                {t('bots.teamShare.cancel', 'Cancel')}
              </Button>
              <Button onClick={onShare}>{t('bots.teamShare.shareStaged', 'Share')}</Button>
            </>
          ) : (
            <Button onClick={onClose}>{t('bots.teamShare.done', 'Done')}</Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
