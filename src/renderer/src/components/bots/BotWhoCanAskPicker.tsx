import React, { useLayoutEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
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
import { useMemberSearch } from './bot-who-can-ask-search'
import { confirmedDraftMembers, useMemberDraft } from './bot-who-can-ask-draft'
import { gitHubCheckingUsername, gitHubSnapshotCount } from './github/github-who-can-ask-copy'

// How close to a service's cap the picker starts showing it while people are ticked.
const NEAR_CAP = 5
type Found = BotWhoCanAskFound['members'][number]

const matches = (name: string, needle: string): boolean =>
  needle === '' || name.toLowerCase().includes(needle)

// Buttons handle their own keys so cmdk cannot toggle the highlighted person on Enter.
const keepButtonEnter = (event: React.KeyboardEvent<HTMLButtonElement>): void => {
  if (event.key === 'Enter') {
    event.stopPropagation()
  }
}

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
  const {
    search,
    retry,
    retryInPlace,
    retrying,
    identities,
    checkingIdentities,
    isCheckingIdentities,
    session
  } = useMemberSearch(service, query)
  const {
    members: picked,
    names: pickedNames,
    toggle
  } = useMemberDraft(service.kind === 'github' ? session : undefined)
  const inputRef = useRef<HTMLInputElement>(null)
  const retryRef = useRef<HTMLButtonElement>(null)
  const restoreRetryFocus = useRef(false)
  useLayoutEffect(() => {
    restoreRetryFocus.current = false
  }, [query, service.begin, service.search])
  useLayoutEffect(() => {
    if (retrying || search.status === 'loading' || !restoreRetryFocus.current) {
      return
    }
    restoreRetryFocus.current = false
    const input = inputRef.current
    if (input && input.ownerDocument.activeElement === input.ownerDocument.body) {
      const target = retryRef.current ?? input
      target.focus()
    }
  }, [retrying, search])
  const rememberRetryFocus = (action: () => void): void => {
    const button = retryRef.current
    restoreRetryFocus.current = button !== null && button.ownerDocument.activeElement === button
    action()
  }
  // On GitHub a leading @ is how people write a handle, not part of it: matched as its search does.
  const typed = query.trim().toLowerCase()
  const needle = service.kind === 'github' ? typed.replace(/^@/, '') : typed
  const listed = service.listed(bot.members)
  const added = new Set(listed.map((member) => member.id))
  const isOwner = (id: string): boolean =>
    id === service.ownerId || (service.otherOwnerIds?.includes(id) ?? false)
  // A pick that has since become the owner (a newly linked account), got access elsewhere, or
  // whose listed name a live lookup gave to someone else is no longer something to add: it leaves
  // the picks, the count and what Add saves. A live lookup's current name replaces the draft's,
  // so Selected, the confirmation and what is saved name them as they are now.
  const picks = confirmedDraftMembers(picked, identities).filter(
    (member) => !isOwner(member.id) && !added.has(member.id)
  )
  const full =
    bot.members.length + picks.length >= BOT_MAX_MEMBERS || added.size + picks.length >= service.max
  const isPicked = (id: string): boolean => picks.some((entry) => entry.id === id)

  const found =
    search.status === 'ready'
      ? search.found.members.flatMap((person) => {
          if (identities.superseded.has(person.id)) {
            return []
          }
          const current = identities.names[person.id]
          if (!current || current === person.name) {
            return [person]
          }
          return matches(current, needle) || matches(person.handle ?? '', needle)
            ? [{ ...person, name: current }]
            : []
        })
      : []
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
  const answer = search.status === 'ready' ? search.found : undefined
  const noteWithTag = answer?.noteWithTag
  const note =
    noteWithTag && addable.some((person) => person.tag === noteWithTag.tag)
      ? noteWithTag.note
      : answer?.note
  const labels = answer?.labels
  const snapshot = answer?.snapshot
  const footerCount = (count: string): string =>
    snapshot ? gitHubSnapshotCount(count, snapshot, t) : count
  const searching =
    search.status === 'loading' && search.announce
      ? t('bots.whoCanAsk.searching', 'Searching…')
      : ''

  /** `handle`: the muted text beside the name; `realName`: what else a search may match them by. */
  const pickRow = (
    member: BotMember,
    handle: string | undefined,
    // Only a real name: a status tag in the handle slot must never be remembered as one.
    realName: string | undefined
  ): React.JSX.Element => {
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
        <PersonLabel name={member.name || member.id} handle={handle} />
      </CommandItem>
    )
  }
  // GitHub filters Selected with the query; other connectors keep every pick visible.
  const offScreen = picks.filter(
    (member) =>
      !addable.some((person) => person.id === member.id) &&
      (service.kind !== 'github' ||
        matches(member.name || member.id, needle) ||
        matches(pickedNames[member.id] ?? '', needle))
  )
  const selectedGroup =
    offScreen.length > 0 ? (
      <CommandGroup heading={t('bots.whoCanAsk.selectedHeading', 'Selected')}>
        {offScreen.map((member) => pickRow(member, pickedNames[member.id], pickedNames[member.id]))}
      </CommandGroup>
    ) : null

  // Asks a failed part of this search again in place; the query, rows and picks stay.
  const retryAction =
    search.status === 'ready' && search.found.retryable ? (
      <Button
        size="xs"
        variant="outline"
        ref={retryRef}
        disabled={retrying}
        onKeyDown={keepButtonEnter}
        onClick={() => rememberRetryFocus(retryInPlace)}
      >
        {t('bots.whoCanAsk.retry', 'Try again')}
      </Button>
    ) : null
  const noMatch =
    !idle &&
    search.status === 'ready' &&
    addable.length === 0 &&
    withAccess.length === 0 &&
    !ownerShown &&
    // A ticked person still matching the search is a result: "no one found" would contradict it.
    (service.kind !== 'github' || offScreen.length === 0)
  // A note on what the search couldn't cover replaces a hint or empty result's usual detail.
  const peopleGroup = idle ? (
    <PickerNote title={idle.title} detail={note ?? idle.detail} action={retryAction} />
  ) : search.status === 'failed' ? (
    <div role="alert" className="flex items-center gap-2 p-3 text-sm">
      <span className="min-w-0 flex-1 text-destructive">{service.errorMessage(search.error)}</span>
      <Button
        size="xs"
        variant="outline"
        ref={retryRef}
        disabled={retrying}
        onKeyDown={keepButtonEnter}
        onClick={() => rememberRetryFocus(retry)}
      >
        {t('bots.whoCanAsk.retry', 'Try again')}
      </Button>
    </div>
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
    <Command
      shouldFilter={false}
      onFocusCapture={(event) => {
        if (event.target !== retryRef.current) {
          restoreRetryFocus.current = false
        }
      }}
    >
      <CommandInput
        ref={inputRef}
        autoFocus
        value={query}
        onValueChange={setQuery}
        placeholder={search.searchPlaceholder ?? service.searchPlaceholder}
      />
      <CommandList>
        {selectedGroup}
        {selectedGroup && peopleGroup ? <CommandSeparator className="mx-0" /> : null}
        <p role="status" className={searching ? 'p-3 text-sm text-muted-foreground' : 'sr-only'}>
          {searching}
        </p>
        {peopleGroup}
        {(selectedGroup || peopleGroup) && accessGroup ? (
          <CommandSeparator className="mx-0" />
        ) : null}
        {accessGroup}
      </CommandList>
      {picks.length === 0 ? (
        <p className="px-3 py-2 text-xs text-muted-foreground tabular-nums">
          {footerCount(
            t('bots.whoCanAsk.addedCount', '{{count}} of {{max}} added', {
              count: added.size,
              max: service.max
            })
          )}
        </p>
      ) : added.size + picks.length >= service.max - NEAR_CAP ? (
        // While picking, the footer counts the picks; the cap shows only once it is close.
        <p className="px-3 py-2 text-xs text-muted-foreground tabular-nums">
          {t('bots.whoCanAsk.nearCap', '{{count}} of {{max}}', {
            count: added.size + picks.length,
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
      {picks.length > 0 ? (
        <div className="flex items-center justify-between gap-2 border-t border-border p-2 pl-3">
          <span className="text-xs text-muted-foreground">
            {footerCount(
              t('bots.whoCanAsk.selected', '{{count}} selected', { count: picks.length })
            )}
          </span>
          <Button
            size="sm"
            disabled={checkingIdentities}
            aria-label={checkingIdentities ? gitHubCheckingUsername(t) : undefined}
            onKeyDown={keepButtonEnter}
            onClick={() => {
              if (!isCheckingIdentities()) {
                onPicked(picks)
              }
            }}
          >
            {checkingIdentities ? (
              <Loader2 aria-hidden className="animate-spin motion-reduce:animate-none" />
            ) : null}
            {picks.length === 1
              ? t('bots.whoCanAsk.addOne', 'Add 1 person')
              : t('bots.whoCanAsk.addMany', 'Add {{count}} people', { count: picks.length })}
          </Button>
        </div>
      ) : null}
    </Command>
  )
}
