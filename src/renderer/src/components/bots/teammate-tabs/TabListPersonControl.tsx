// The avatar ⌄ at the start of a shared agent's Home tab row: whose tabs this window shows. At rest it
// is the viewer's avatar; showing someone else's, their avatar and name with × to go back.
import { useState } from 'react'
import { Check, ChevronDown, Search, X } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { ConnectorAvatar } from '@/components/ConnectorAvatar'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import type { TabListPeople, TabListPersonEntry } from './tab-list-people'
import {
  sameTabListPerson,
  useViewedTabList,
  viewTabList,
  type TabListPerson
} from './viewed-tab-list'

/** Past this many people the menu offers a search. */
const SEARCH_FROM_PEOPLE = 9

const firstName = (name: string): string => name.trim().split(/\s+/)[0] || name

function PersonAvatar({ name, className }: { name: string; className: string }) {
  return <ConnectorAvatar avatarUrl={null} name={name} className={className} />
}

function PersonRow({
  entry,
  label,
  checked
}: {
  entry: TabListPersonEntry | null
  label: string
  checked: boolean
}): React.JSX.Element {
  return (
    <>
      <PersonAvatar name={entry?.name ?? label} className="size-5 text-[8px]" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {checked ? <Check className="ml-1" /> : <span className="ml-1 size-4 shrink-0" />}
    </>
  )
}

export function TabListPersonControl({
  homeKey,
  people
}: {
  homeKey: string
  people: TabListPeople
}): React.JSX.Element {
  const t = useTranslate()
  const viewed = useViewedTabList(homeKey)
  const [query, setQuery] = useState('')
  const viewedPerson = viewed?.person ?? null
  const viewedEntry = viewedPerson
    ? (people.others.find((entry) => sameTabListPerson(entry.person, viewedPerson)) ?? null)
    : null
  const show = (person: TabListPerson | null): void => {
    setQuery('')
    viewTabList(homeKey, person)
  }
  const searching = people.others.length + 1 >= SEARCH_FROM_PEOPLE
  const needle = query.trim().toLowerCase()
  const listed = needle
    ? people.others.filter((entry) => entry.name.toLowerCase().includes(needle))
    : people.others
  const label = viewedEntry
    ? t('bots.teammateTabs.showing', 'Showing {{name}}’s tabs', { name: viewedEntry.name })
    : t('bots.teammateTabs.control', 'Whose tabs')
  return (
    <div className="flex shrink-0 items-center self-center pr-0.5 pl-1.5">
      <DropdownMenu onOpenChange={(open) => !open && setQuery('')}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={label}
            className={cn(
              'flex h-6 items-center gap-1.5 rounded-md pr-1.5 pl-1 text-xs font-medium hover:bg-accent/50 hover:text-foreground data-[state=open]:bg-accent/50 data-[state=open]:text-foreground',
              !viewedEntry && 'text-muted-foreground'
            )}
          >
            <PersonAvatar name={(viewedEntry ?? people.own).name} className="size-4 text-[9px]" />
            {viewedEntry ? (
              <span className="max-w-40 truncate text-foreground">{viewedEntry.name}</span>
            ) : (
              <ChevronDown className="size-3 opacity-80" />
            )}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-58">
          <DropdownMenuItem onSelect={() => show(null)}>
            <PersonRow
              entry={people.own}
              label={t('bots.teammateTabs.yours', 'Your tabs')}
              checked={!viewedEntry}
            />
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {searching ? (
            <div className="relative mb-1 px-0.5">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                // The menu's typeahead would take the letters otherwise; Escape still closes it.
                onKeyDown={(event) => event.key !== 'Escape' && event.stopPropagation()}
                placeholder={t('bots.teammateTabs.search', 'Search people')}
                density="compact"
                inset="leadingIcon"
              />
            </div>
          ) : null}
          <div className="scrollbar-sleek max-h-[15rem] overflow-y-auto">
            {listed.map((entry) => (
              <DropdownMenuItem
                key={entry.person === 'owner' ? 'owner' : entry.person.accountId}
                onSelect={() => show(entry.person)}
              >
                <PersonRow
                  entry={entry}
                  label={t('bots.teammateTabs.theirs', '{{name}}’s tabs', {
                    name: firstName(entry.name)
                  })}
                  checked={
                    viewedEntry !== null && sameTabListPerson(viewedEntry.person, entry.person)
                  }
                />
              </DropdownMenuItem>
            ))}
          </div>
        </DropdownMenuContent>
      </DropdownMenu>
      {viewedEntry ? (
        <button
          type="button"
          aria-label={t('bots.teammateTabs.back', 'Back to your tabs')}
          onClick={() => show(null)}
          className="flex size-5 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X className="size-3" />
        </button>
      ) : null}
    </div>
  )
}
