import React, { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
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
import { useWhoCanAskSearch } from './use-who-can-ask-search'
import { WhoCanAskIdentityLedger } from './who-can-ask-identity-ledger'
import { currentPicks, currentRows, heldPicks } from './who-can-ask-picks'
import { recomputeOn } from '@/lib/recompute-on'

// How close to a service's cap the picker starts showing it while people are ticked.
const NEAR_CAP = 5

type Found = BotWhoCanAskFound['members'][number]

const matches = (name: string, needle: string): boolean =>
  needle === '' || name.toLowerCase().includes(needle)

// Saved as the chips draw it: a found person's picture is kept, their handle isn't; an app is
// marked so, so it draws as one.
const asMember = (found: Found, service: BotWhoCanAskService): BotMember => ({
  id: found.id,
  name: found.name,
  ...(found.avatarUrl ? { avatarUrl: found.avatarUrl } : {}),
  ...(found.app ? { kind: 'app' as const } : {}),
  ...service.stamp
})

// A long login stops at about 60% of the row, so the real name beside it keeps room: for a
// teammate, the real name is what tells them apart.
function PersonLabel({ name, handle }: { name: string; handle?: string }): React.JSX.Element {
  const shown = handle && handle !== name ? handle : undefined
  return (
    <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
      <span className={shown ? 'max-w-[60%] shrink-0 truncate' : 'min-w-0 truncate'}>{name}</span>
      {shown ? (
        <span className="min-w-0 truncate text-xs text-muted-foreground">{shown}</span>
      ) : null}
    </span>
  )
}

function PickerNote({
  title,
  detail,
  action
}: {
  title: string
  detail: string
  action?: React.ReactNode
}): React.JSX.Element {
  return (
    <div role="status" className="px-6 py-6 text-center text-sm text-muted-foreground">
      <p className="text-foreground">{title}</p>
      <p className="mt-1 whitespace-pre-line text-xs">{detail}</p>
      {action ? <div className="mt-3 flex justify-center">{action}</div> : null}
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
  const [ticked, setTicked] = useState<BotMember[]>([])
  // The draft as of the last change, for a check settling between renders: it is judged against
  // the ticks present at that moment, not against whatever the ledger says by the next render.
  const draft = useRef<BotMember[]>([])
  const setDraft = (next: BotMember[]): void => {
    draft.current = next
    setTicked(next)
  }
  // A ticked person's real name, part of who they are: Selected shows it beside them, and a
  // search by it still finds them once they scroll off. A row's source tag is never kept.
  const [realNames, setRealNames] = useState<Readonly<Record<string, string>>>({})
  // What username checks said this open, across its sessions; the picks follow it.
  const [ledger] = useState(() => new WhoCanAskIdentityLedger())
  // Every read of the ledger below is keyed on its version, so none is served stale.
  const ledgerVersion = useSyncExternalStore(ledger.subscribe, ledger.version)
  // A tick a check shows to be someone else's leaves the draft at that settlement: a later check
  // naming that account again makes it pickable, not silently picked. Decided right as each check
  // settles, so a recovery settling in the same batch can't keep the earlier tick; a deliberate
  // later tick is a new entry and stays.
  useEffect(
    () =>
      ledger.onSettle(() => {
        const current = draft.current
        const kept = current.filter(
          (member) => ledger.identity(member.id, member.name || member.id).status !== 'contradicted'
        )
        if (kept.length !== current.length) {
          draft.current = kept
          setTicked(kept)
        }
      }),
    [ledger]
  )
  const { search, retrying, retry } = useWhoCanAskSearch(service, query, ledger)
  const checkingId = useId()
  const typed = query.trim()
  const needle = (service.normalizeQuery?.(typed) ?? typed).toLowerCase()
  const listed = service.listed(bot.members)
  const added = new Set(listed.map((member) => member.id))
  const isOwner = (id: string): boolean =>
    id === service.ownerId || (service.otherOwnerIds?.includes(id) ?? false)
  const picked = recomputeOn([ledgerVersion], () =>
    currentPicks(ticked, (id) => !added.has(id) && !isOwner(id), ledger)
  )
  // Add waits for a check that could still show one of these picks to be someone else.
  const held = recomputeOn([ledgerVersion], () => heldPicks(picked, ticked, realNames, ledger))
  const full =
    bot.members.length + picked.length >= BOT_MAX_MEMBERS ||
    added.size + picked.length >= service.max
  const isPicked = (id: string): boolean => picked.some((entry) => entry.id === id)
  const toggle = (member: BotMember, realName?: string): void => {
    if (realName && realNames[member.id] !== realName) {
      setRealNames((current) => ({ ...current, [member.id]: realName }))
    }
    const current = draft.current.filter((entry) => entry.id !== member.id)
    setDraft(isPicked(member.id) ? current : [...current, { ...member }])
  }

  const found = recomputeOn([ledgerVersion], () =>
    currentRows(search.status === 'ready' ? search.found.members : [], ledger)
  )
  const handles = new Map(found.map((person) => [person.id, person.handle]))
  const addable = found.filter((person) => !added.has(person.id) && !isOwner(person.id))
  const withAccess = listed.filter(
    (member) => matches(member.name || member.id, needle) || found.some((p) => p.id === member.id)
  )
  const ownerShown = needle === '' || found.some((person) => isOwner(person.id))
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
  const labels = search.status === 'ready' ? search.found.labels : undefined

  /** `beside`: the muted text after the name; `realName`: who they are besides their login, kept
   *  with the pick (a source tag beside them is not). */
  const pickRow = (member: BotMember, beside?: string, realName?: string): React.JSX.Element => {
    const on = isPicked(member.id)
    return (
      <CommandItem
        key={member.id}
        value={member.id}
        aria-checked={on}
        disabled={full && !on}
        onSelect={() => toggle(member, realName)}
        className="group/person"
      >
        <Checkbox checked={on} tabIndex={-1} aria-hidden className="pointer-events-none" />
        {/* The highlight's fill swallows an initials avatar's own in the light theme. */}
        <span className="size-6 shrink-0 rounded-full group-data-[selected=true]/person:ring-1 group-data-[selected=true]/person:ring-border">
          <BotMemberAvatar member={member} />
        </span>
        <PersonLabel name={member.name || member.id} handle={beside} />
      </CommandItem>
    )
  }
  // Ticked people the current search doesn't show stay on top. A service that matches people by
  // login and name (GitHub) keeps only those still matching the search; any other keeps them all,
  // so each pick can always be unticked.
  const byName = service.normalizeQuery !== undefined
  // A pick's real name: as ticked, or as a list gave it after the tick.
  const realNameOf = (id: string): string =>
    recomputeOn([ledgerVersion], () => realNames[id] ?? ledger.realName(id) ?? '')
  const offScreen = picked.filter(
    (member) =>
      !addable.some((person) => person.id === member.id) &&
      (!byName ||
        matches(member.name || member.id, needle) ||
        matches(realNameOf(member.id), needle))
  )
  const selectedGroup =
    offScreen.length > 0 ? (
      <CommandGroup heading={t('bots.whoCanAsk.selectedHeading', 'Selected')}>
        {offScreen.map((member) =>
          pickRow(member, realNameOf(member.id) || undefined, realNameOf(member.id) || undefined)
        )}
      </CommandGroup>
    ) : null

  // Asks a failed part of this search again in place; the query, rows and picks stay. Enter is
  // the button's own (the list would take it as picking the highlighted row).
  const retryAction =
    search.status === 'ready' && search.found.retryable ? (
      <Button
        size="xs"
        variant="outline"
        disabled={retrying}
        onClick={retry}
        onKeyDown={(event) => event.stopPropagation()}
      >
        {t('bots.whoCanAsk.retry', 'Try again')}
      </Button>
    ) : null
  // The username check is still out and nothing else shows: not an answer yet.
  const pending =
    search.status === 'ready' &&
    search.found.pending === true &&
    addable.length === 0 &&
    offScreen.length === 0
  // Said apart from the rows and the Add button's own name: a check is still out that could change
  // who a row or a pick is.
  const checking =
    held.length > 0 ||
    (search.status === 'ready' &&
      search.found.pending === true &&
      (addable.length > 0 || offScreen.length > 0))
  const noMatch =
    !idle &&
    !pending &&
    search.status === 'ready' &&
    addable.length === 0 &&
    withAccess.length === 0 &&
    !ownerShown &&
    // A ticked person matched by the search is a result: "no one found" would contradict it. A
    // service that keeps every pick in view says so regardless.
    (!byName || offScreen.length === 0)
  // A note on what the search couldn't cover replaces a hint or empty result's usual detail.
  const peopleGroup = idle ? (
    <PickerNote title={idle.title} detail={note ?? idle.detail} action={retryAction} />
  ) : search.status === 'failed' ? (
    <div role="alert" className="flex items-center gap-2 p-3 text-sm">
      <span className="min-w-0 flex-1 text-destructive">{service.errorMessage(search.code)}</span>
      <Button
        size="xs"
        variant="outline"
        disabled={retrying}
        onClick={retry}
        onKeyDown={(event) => event.stopPropagation()}
      >
        {t('bots.whoCanAsk.retry', 'Try again')}
      </Button>
    </div>
  ) : search.status === 'loading' || pending ? (
    <p role="status" className="p-3 text-sm text-muted-foreground">
      {t('bots.whoCanAsk.searching', 'Searching…')}
    </p>
  ) : addable.length > 0 ? (
    <>
      {scoped.length > 0 ? (
        <CommandGroup heading={labels?.scoped ?? service.scopedHeading ?? service.peopleHeading}>
          {scoped.map((person) => pickRow(asMember(person, service), person.handle, person.handle))}
        </CommandGroup>
      ) : null}
      {unsorted.length > 0 ? (
        <CommandGroup heading={service.peopleHeading}>
          {unsorted.map((person) =>
            pickRow(asMember(person, service), person.tag ?? person.handle, person.handle)
          )}
        </CommandGroup>
      ) : null}
      {outside.length > 0 ? (
        <CommandGroup heading={service.outsideHeading ?? service.peopleHeading}>
          {outside.map((person) =>
            pickRow(
              asMember(person, service),
              person.tag ?? labels?.outsideTag ?? service.outsideTag ?? person.handle,
              person.handle
            )
          )}
        </CommandGroup>
      ) : null}
    </>
  ) : noMatch ? (
    <PickerNote
      action={retryAction}
      {...(search.status === 'ready' && search.found.empty
        ? search.found.empty
        : {
            title: service.noMatch(query.trim()).title,
            detail: note ?? service.noMatch(query.trim()).detail
          })}
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
        <div className="flex items-center gap-2 px-3 pb-2">
          <p className="min-w-0 flex-1 whitespace-pre-line text-xs text-muted-foreground">{note}</p>
          {retryAction}
        </div>
      ) : search.status === 'ready' && !search.found.complete ? (
        <p className="px-3 pb-2 text-xs text-muted-foreground">
          {t(
            'bots.whoCanAsk.incomplete',
            'Not everyone is listed. Search by name to find someone.'
          )}
        </p>
      ) : null}
      {checking && service.checkingStatus ? (
        <p id={checkingId} role="status" className="px-3 pb-2 text-xs text-muted-foreground">
          {service.checkingStatus}
        </p>
      ) : null}
      {picked.length > 0 ? (
        <div className="flex items-center justify-between gap-2 border-t border-border p-2 pl-3">
          <span className="text-xs text-muted-foreground">
            {t('bots.whoCanAsk.selected', '{{count}} selected', {
              count: picked.length
            })}
          </span>
          <Button
            size="sm"
            disabled={held.length > 0}
            aria-describedby={held.length > 0 && service.checkingStatus ? checkingId : undefined}
            onClick={() => onPicked(picked)}
            // Enter is the button's own, as for Try again (the list would pick its highlighted row).
            onKeyDown={(event) => event.stopPropagation()}
          >
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
