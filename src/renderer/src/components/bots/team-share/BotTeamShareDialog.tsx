// Share an agent with people: one Add field whose suggestions name what each adds, then everyone who
// can ask it. The caller owns the people and the search; this draws them and reports picks.
import { useId, useState } from 'react'
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

export function BotTeamShareDialog({
  bot,
  hostName,
  owner,
  people,
  query,
  onQueryChange,
  suggestions,
  onAdd,
  onRemove,
  onResend,
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
  onAdd: (suggestion: TeamShareSuggestion) => void
  onRemove: (person: TeamSharePerson) => void
  onResend: (person: Extract<TeamSharePerson, { kind: 'invite' }>) => void
  onClose: () => void
  /** Rows the caller draws itself after `people`: Slack- and GitHub-only people, from Who can ask. */
  children?: React.ReactNode
}): React.JSX.Element {
  const t = useTranslate()
  const listId = useId()
  const [activeIndex, setActiveIndex] = useState(0)
  // Radix focuses the field on open; leaving the Add row hides the suggestions until it is back.
  const [addRowFocused, setAddRowFocused] = useState(true)
  const open = addRowFocused && query.trim() !== '' && suggestions !== null
  const shown = open ? suggestions : []
  const listed = shown.length > 0
  const active = shown.length > 0 ? Math.min(activeIndex, shown.length - 1) : -1
  const optionId = (index: number) => `${listId}-${index}`
  const pick = (suggestion: TeamShareSuggestion | undefined) => {
    if (suggestion) {
      onAdd(suggestion)
      setActiveIndex(0)
    }
  }
  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
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
        onEscapeKeyDown={(event) => {
          // Esc clears a search before it closes the dialog.
          if (query !== '') {
            event.preventDefault()
            onQueryChange('')
          }
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
            <Input
              role="combobox"
              aria-expanded={listed}
              aria-controls={listed ? listId : undefined}
              aria-autocomplete="list"
              aria-activedescendant={active >= 0 ? optionId(active) : undefined}
              aria-label={t('bots.teamShare.addLabel', 'Add people')}
              autoComplete="off"
              spellCheck={false}
              placeholder={t('bots.teamShare.addPlaceholder', 'Email, Slack @name or GitHub login')}
              value={query}
              onChange={(event) => {
                onQueryChange(event.target.value)
                setActiveIndex(0)
              }}
              onKeyDown={onKeyDown}
            />
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
          <Button variant="outline" disabled={active < 0} onClick={() => pick(shown[active])}>
            {t('bots.teamShare.add', 'Add')}
          </Button>
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
          <Button onClick={onClose}>{t('bots.teamShare.done', 'Done')}</Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
