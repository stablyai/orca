import React, { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator
} from '@/components/ui/command'
import { useTranslate } from '@/i18n/use-translate'
import { BOT_MAX_MEMBERS, type Bot, type BotMember } from '../../../../shared/bot-types'
import { BotMemberAvatar, BotOwnerAvatar } from './bot-connector-people'
import type { BotWhoCanAskFound, BotWhoCanAskService } from './BotWhoCanAskList'

const SEARCH_DEBOUNCE_MS = 250
// How close to a service's cap the picker starts showing it while people are ticked.
const NEAR_CAP = 5

type Search =
  | { status: 'loading' }
  | { status: 'ready'; found: BotWhoCanAskFound }
  | { status: 'failed'; error: string }

type Found = BotWhoCanAskFound['members'][number]

function useMemberSearch(
  service: BotWhoCanAskService,
  query: string
): { search: Search; retry: () => void } {
  const [search, setSearch] = useState<Search>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const { search: find, errorMessage } = service
  useEffect(() => {
    let current = true
    setSearch({ status: 'loading' })
    const timer = setTimeout(() => {
      void find(query.trim()).then((result) => {
        if (current) {
          setSearch(
            result.ok
              ? { status: 'ready', found: result.value }
              : { status: 'failed', error: errorMessage(result.error) }
          )
        }
      })
    }, SEARCH_DEBOUNCE_MS)
    return () => {
      current = false
      clearTimeout(timer)
    }
  }, [find, errorMessage, query, attempt])
  return { search, retry: () => setAttempt((count) => count + 1) }
}

const matches = (name: string, needle: string): boolean =>
  needle === '' || name.toLowerCase().includes(needle)

// Saved as the chips draw it: a found person's picture is kept, their handle isn't.
const asMember = (found: Found, service: BotWhoCanAskService): BotMember => ({
  id: found.id,
  name: found.name,
  ...(found.avatarUrl ? { avatarUrl: found.avatarUrl } : {}),
  ...service.stamp
})

function PersonLabel({ name, handle }: { name: string; handle?: string }): React.JSX.Element {
  return (
    <span className="min-w-0 flex-1 truncate">
      {name}
      {handle && handle !== name ? (
        <span className="ml-1.5 text-xs text-muted-foreground">{handle}</span>
      ) : null}
    </span>
  )
}

function PickerNote({ title, detail }: { title: string; detail: string }): React.JSX.Element {
  return (
    <div role="status" className="px-6 py-6 text-center text-sm text-muted-foreground">
      <p className="text-foreground">{title}</p>
      <p className="mt-1 text-xs">{detail}</p>
    </div>
  )
}

/** People with access › Add: tick people found in this row's workspace, then add them together.
 *  Those who already have access stay listed, greyed, so a search for them never looks empty. */
export function BotWhoCanAskPicker({
  bot,
  service,
  owner,
  onPicked
}: {
  bot: Bot
  service: BotWhoCanAskService
  /** How the owner row names the owner: You, or their name there. */
  owner: string
  onPicked: (picked: BotMember[]) => void
}): React.JSX.Element {
  const t = useTranslate()
  const [query, setQuery] = useState('')
  const [picked, setPicked] = useState<BotMember[]>([])
  // A ticked person's row label and real name, so they look the same and a search by their real
  // name still shows them once they scroll off.
  const [pickedLabels, setPickedLabels] = useState<
    Readonly<Record<string, { label?: string; name?: string }>>
  >({})
  const { search, retry } = useMemberSearch(service, query)
  const needle = query.trim().toLowerCase()
  const listed = service.listed(bot.members)
  const added = new Set(listed.map((member) => member.id))
  const full =
    bot.members.length + picked.length >= BOT_MAX_MEMBERS ||
    added.size + picked.length >= service.max
  const isPicked = (id: string): boolean => picked.some((entry) => entry.id === id)
  const toggle = (member: BotMember, label?: string, realName?: string): void => {
    const known = pickedLabels[member.id]
    if ((label || realName) && (known?.label !== label || known?.name !== realName)) {
      setPickedLabels((current) => ({ ...current, [member.id]: { label, name: realName } }))
    }
    setPicked((current) =>
      isPicked(member.id) ? current.filter((entry) => entry.id !== member.id) : [...current, member]
    )
  }

  const found = search.status === 'ready' ? search.found.members : []
  const handles = new Map(found.map((person) => [person.id, person.handle]))
  const addable = found.filter((person) => !added.has(person.id) && person.id !== service.ownerId)
  const withAccess = listed.filter(
    (member) => matches(member.name || member.id, needle) || found.some((p) => p.id === member.id)
  )
  const ownerShown = needle === '' || found.some((person) => person.id === service.ownerId)
  // A service that suggests people fills an empty search; the hint is for one that suggests nobody.
  const idle =
    needle === '' && search.status === 'ready' && addable.length === 0
      ? service.idleHint
      : undefined
  // Grouped by where the service found them; a service that doesn't say lists everyone together.
  const grouped = service.scopedHeading !== undefined || service.outsideHeading !== undefined
  const scoped = grouped ? addable.filter((person) => person.group === 'scoped') : []
  const outside = grouped ? addable.filter((person) => person.group === 'outside') : []
  const unsorted = grouped ? addable.filter((person) => person.group === undefined) : addable
  const note = search.status === 'ready' ? search.found.note : undefined

  /** `handle`: the muted text beside the name; `realName`: what else a search may match them by. */
  const pickRow = (
    member: BotMember,
    handle?: string,
    realName: string | undefined = handle
  ): React.JSX.Element => {
    const on = isPicked(member.id)
    return (
      <CommandItem
        key={member.id}
        value={member.id}
        aria-checked={on}
        disabled={full && !on}
        onSelect={() => toggle(member, handle, realName)}
      >
        <Checkbox checked={on} tabIndex={-1} aria-hidden className="pointer-events-none" />
        <span className="size-6 shrink-0">
          <BotMemberAvatar member={member} />
        </span>
        <PersonLabel name={member.name || member.id} handle={handle} />
      </CommandItem>
    )
  }
  // Ticked people the current search doesn't show stay on top while they still match it, so a
  // search never lists someone it doesn't match; the footer keeps counting everyone ticked.
  const offScreen = picked.filter(
    (member) =>
      !addable.some((person) => person.id === member.id) &&
      (matches(member.name || member.id, needle) ||
        matches(pickedLabels[member.id]?.name ?? '', needle))
  )
  const selectedGroup =
    offScreen.length > 0 ? (
      <CommandGroup heading={t('bots.whoCanAsk.selectedHeading', 'Selected')}>
        {offScreen.map((member) =>
          pickRow(member, pickedLabels[member.id]?.label, pickedLabels[member.id]?.name)
        )}
      </CommandGroup>
    ) : null

  const noMatch =
    !idle &&
    search.status === 'ready' &&
    addable.length === 0 &&
    withAccess.length === 0 &&
    !ownerShown
  // A note on what the search couldn't cover replaces a hint or empty result's usual detail.
  const peopleGroup = idle ? (
    <PickerNote title={idle.title} detail={note ?? idle.detail} />
  ) : search.status === 'failed' ? (
    <div role="alert" className="flex items-center gap-2 p-3 text-sm">
      <span className="min-w-0 flex-1 text-destructive">{search.error}</span>
      <Button size="xs" variant="outline" onClick={retry}>
        {t('bots.whoCanAsk.retry', 'Try again')}
      </Button>
    </div>
  ) : search.status === 'loading' ? (
    <p role="status" className="p-3 text-sm text-muted-foreground">
      {t('bots.whoCanAsk.searching', 'Searching…')}
    </p>
  ) : addable.length > 0 ? (
    <>
      {scoped.length > 0 ? (
        <CommandGroup heading={service.scopedHeading ?? service.peopleHeading}>
          {scoped.map((person) => pickRow(asMember(person, service), person.handle))}
        </CommandGroup>
      ) : null}
      {unsorted.length > 0 ? (
        <CommandGroup heading={service.peopleHeading}>
          {unsorted.map((person) => pickRow(asMember(person, service), person.handle))}
        </CommandGroup>
      ) : null}
      {outside.length > 0 ? (
        <CommandGroup heading={service.outsideHeading ?? service.peopleHeading}>
          {outside.map((person) =>
            pickRow(asMember(person, service), service.outsideTag ?? person.handle, person.handle)
          )}
        </CommandGroup>
      ) : null}
    </>
  ) : noMatch ? (
    <PickerNote
      title={service.noMatch(query.trim()).title}
      detail={note ?? service.noMatch(query.trim()).detail}
    />
  ) : null

  const hasAccessLabel = t('bots.whoCanAsk.canAsk', 'Can ask')
  const accessGroup =
    withAccess.length > 0 || ownerShown ? (
      <CommandGroup heading={hasAccessLabel}>
        {ownerShown ? (
          <CommandItem value="owner" disabled>
            <span className="size-4 shrink-0" />
            <span className="size-6 shrink-0">
              <BotOwnerAvatar />
            </span>
            <PersonLabel name={owner} handle={t('bots.whoCanAsk.owner', 'Owner')} />
            <span className="text-xs text-muted-foreground">{hasAccessLabel}</span>
          </CommandItem>
        ) : null}
        {withAccess.map((member) => (
          <CommandItem key={member.id} value={`listed:${member.id}`} disabled>
            <span className="size-4 shrink-0" />
            <span className="size-6 shrink-0">
              <BotMemberAvatar member={member} />
            </span>
            <PersonLabel name={member.name || member.id} handle={handles.get(member.id)} />
            <span className="text-xs text-muted-foreground">{hasAccessLabel}</span>
          </CommandItem>
        ))}
      </CommandGroup>
    ) : null

  return (
    <Command shouldFilter={false}>
      <CommandInput
        autoFocus
        value={query}
        onValueChange={setQuery}
        placeholder={service.searchPlaceholder}
      />
      <CommandList>
        {selectedGroup}
        {selectedGroup && peopleGroup ? <CommandSeparator className="mx-0" /> : null}
        {peopleGroup}
        {(selectedGroup || peopleGroup) && accessGroup ? (
          <CommandSeparator className="mx-0" />
        ) : null}
        {accessGroup}
      </CommandList>
      {picked.length === 0 ? (
        <p className="px-3 py-2 text-xs text-muted-foreground tabular-nums">
          {t('bots.whoCanAsk.addedCount', '{{count}} of {{max}} added', {
            count: added.size,
            max: service.max
          })}
        </p>
      ) : added.size + picked.length >= service.max - NEAR_CAP ? (
        // While picking, the footer counts the picks; the cap shows only once it is close.
        <p className="px-3 py-2 text-xs text-muted-foreground tabular-nums">
          {t('bots.whoCanAsk.nearCap', '{{count}} of {{max}}', {
            count: added.size + picked.length,
            max: service.max
          })}
        </p>
      ) : null}
      {note && !idle && !noMatch ? (
        <p className="px-3 pb-2 text-xs text-muted-foreground">{note}</p>
      ) : search.status === 'ready' && !search.found.complete ? (
        <p className="px-3 pb-2 text-xs text-muted-foreground">
          {t(
            'bots.whoCanAsk.incomplete',
            'Not everyone is listed. Search by name to find someone.'
          )}
        </p>
      ) : null}
      {picked.length > 0 ? (
        <div className="flex items-center justify-between gap-2 border-t border-border p-2 pl-3">
          <span className="text-xs text-muted-foreground">
            {t('bots.whoCanAsk.selected', '{{count}} selected', {
              count: picked.length
            })}
          </span>
          <Button size="sm" onClick={() => onPicked(picked)}>
            {picked.length === 1
              ? t('bots.whoCanAsk.addOne', 'Add 1 person')
              : t('bots.whoCanAsk.addMany', 'Add {{count}} people', {
                  count: picked.length
                })}
          </Button>
        </div>
      ) : null}
    </Command>
  )
}
