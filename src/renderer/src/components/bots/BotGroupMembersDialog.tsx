import { botErrorText } from './bot-presentation'
import { translate } from '@/i18n/i18n'
import { botRefKey } from '@/lib/bot-hosts'
import { callBotGroupRpc } from '@/lib/bot-group-rpc'
import { useTranslate } from '@/i18n/use-translate'
import { useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useBots } from '@/lib/bot-catalog'
import { openBotGroup } from '@/lib/bot-group-catalog'
import { refreshBotGroups } from '@/lib/bot-group-list'
import type { BotGroup } from '../../../../shared/bots/bot-group'
import type { Bot } from '../../../../shared/bot-types'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host/execution-host'
import { BotGroupMemberHostGroup, BotGroupMemberRow } from './BotGroupMemberRow'
import { useBotPurposes } from './use-bot-purposes'
import { BotNameSuggestion, takeSuggestionOnTab } from './BotNameSuggestion'
import { BotPickFilter, BotPickRows, FILTER_FROM, filterByName } from './BotPickList'
import { BotGroupFaceCluster } from './BotGroupFaceCluster'
import {
  groupMemberKeys,
  mixable,
  remoteRoster,
  withUnlistedMembers
} from './bot-group-members-dialog-roster'
import {
  BOT_GROUP_NAME_MAX_LENGTH,
  botGroupMissing,
  botGroupNameSuggestion,
  botGroupPickOrder,
  botGroupUnchanged
} from '../../../../shared/bots/bot-group-pick'
import { useBotGroupDelete } from './use-bot-group-delete'
import { toast } from 'sonner'
import { isPairedWebClientWindow } from '@/app-shell/chrome/desktop-window-chrome'

export function BotGroupMembersDialog({
  group,
  onClose
}: {
  group?: BotGroup
  onClose: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const listedBots = useBots()
  // A room on this computer can also hold bots on paired computers; a paired server's room holds
  // only that server's bots. A paired web window's bots all live on its one server.
  const canMix = !isPairedWebClientWindow() && (!group || group.hostId === LOCAL_EXECUTION_HOST_ID)
  // In a room here, a remote member whose computer isn't listed now still shows, so it can be
  // removed. Elsewhere (another computer's room, a paired web window) the remote roster isn't shown.
  const allBots = useMemo(
    () => (canMix ? withUnlistedMembers(listedBots, group) : listedBots),
    [canMix, listedBots, group]
  )
  const manyHosts = useMemo(
    () => !isPairedWebClientWindow() && new Set(allBots.map((bot) => bot.hostId)).size > 1,
    [allBots]
  )
  const savedKeys = useMemo(() => (group ? groupMemberKeys(group) : []), [group])
  const [name, setName] = useState(group?.name ?? '')
  // In pick order, by host-qualified key: the picture and the suggested name follow it.
  const [selected, setSelected] = useState<string[]>(savedKeys)
  const [query, setQuery] = useState('')
  const [filterFocused, setFilterFocused] = useState(false)
  const [popped, setPopped] = useState<string | null>(null)
  const purposes = useBotPurposes()
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const deleteGroup = useBotGroupDelete()
  const defaultKey =
    group?.replyMode.kind === 'bot'
      ? botRefKey({ hostId: group.hostId, id: group.replyMode.botId })
      : null
  const removedDefault = defaultKey !== null && !selected.includes(defaultKey)
  const defaultName = allBots.find((bot) => botRefKey(bot) === defaultKey)?.name
  const order = botGroupPickOrder(savedKeys, selected)
  const picked = order.flatMap((key) => allBots.find((bot) => botRefKey(bot) === key) ?? [])
  const pickHosts = new Set(picked.map((bot) => bot.hostId))
  // Bots on several computers make a room here, which needs one of this computer's own.
  const hostedHere = group ? group.hostId === LOCAL_EXECUTION_HOST_ID : pickHosts.size > 1
  const needsLocal =
    canMix && hostedHere && order.length > 0 && !pickHosts.has(LOCAL_EXECUTION_HOST_ID)
  const suggestion = name ? null : suggestGroupName(picked.map((bot) => bot.name))
  const missing = needsLocal
    ? group
      ? t('bots.groups.needsLocalBot', 'This group needs at least one bot on this computer.')
      : t('bots.groups.pickLocalBot', 'Pick a bot on this computer')
    : missingText(botGroupMissing(order.length, name, group !== undefined))
  // Editing saves only a real change: a new name, or other members or order.
  const unchanged =
    group !== undefined && botGroupUnchanged({ name: group.name, botIds: savedKeys }, name, order)
  const shownBots = filterByName(allBots, query, (bot) => bot.name)
  const showFilter = allBots.length > FILTER_FROM || (!group && (query !== '' || filterFocused))
  const noMatches = shownBots.length === 0 && query.trim() !== ''
  // Keep each row under the same parent when a computer appears or goes offline.
  const shownByHost = group ? null : Map.groupBy(shownBots, (bot) => bot.hostId)
  // The host a pick is held to: anywhere a mixed room can reach, else the first pick's computer.
  const pickHost = group?.hostId ?? picked[0]?.hostId ?? null
  const elsewhere = (bot: Bot) =>
    canMix ? !mixable(bot.hostId) : pickHost !== null && bot.hostId !== pickHost
  const someElsewhere = shownBots.some(elsewhere)
  const toggle = (bot: Bot) => {
    const key = botRefKey(bot)
    const on = selected.includes(key)
    setSelected(on ? selected.filter((x) => x !== key) : [...selected, key])
    setPopped(on ? null : key)
  }
  const renderMember = (bot: Bot, hostLabel?: string) => {
    const key = botRefKey(bot)
    const unavailable = elsewhere(bot)
    return (
      <BotGroupMemberRow
        key={key}
        bot={bot}
        purpose={purposes.get(key) ?? null}
        on={!unavailable && selected.includes(key)}
        pop={!unavailable && popped === key}
        disabled={saving || unavailable}
        describedBy={unavailable ? 'bot-group-same-computer' : undefined}
        showHost={group !== undefined && manyHosts}
        hostLabel={hostLabel}
        compact={!group}
        onToggle={() => toggle(bot)}
      />
    )
  }
  const save = async () => {
    if (saving || missing || unchanged) {
      return
    }
    setSaving(true)
    try {
      // A group whose bots share a computer lives there; one spanning computers lives here.
      const spans = pickHosts.size > 1 || (group?.remoteMembers?.length ?? 0) > 0
      const host = group ?? (spans ? { hostId: LOCAL_EXECUTION_HOST_ID } : picked[0])
      const local = picked.filter((bot) => bot.hostId === host.hostId)
      const remoteBots =
        canMix && host.hostId === LOCAL_EXECUTION_HOST_ID
          ? remoteRoster(order, allBots, group)
          : undefined
      const roster = {
        name: name.trim(),
        botIds: local.map((bot) => bot.id),
        // Sent only where a room spans computers, so a same-computer room's call is as before.
        ...(spans && remoteBots ? { remoteBots } : {})
      }
      const { group: saved } = await callBotGroupRpc<{ group: BotGroup }>(
        host,
        group ? 'bots.groups.update' : 'bots.groups.create',
        group ? { groupId: group.id, revision: group.revision, ...roster } : roster
      )
      await refreshBotGroups()
      onClose()
      if (!group) {
        openCreatedGroup(saved)
      }
    } catch (error) {
      setError(botErrorText(error))
      setSaving(false)
    }
  }
  const actions = (
    <>
      <Button variant="ghost" size="sm" onClick={onClose} disabled={saving}>
        {t('bots.groups.cancel', 'Cancel')}
      </Button>
      <Button
        size="sm"
        onClick={() => void save()}
        disabled={saving || missing !== null || unchanged}
      >
        {saving
          ? t('bots.groups.saving', 'Saving…')
          : group
            ? t('bots.groups.save', 'Save')
            : t('bots.groups.create', 'Create')}
      </Button>
    </>
  )
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) {
          onClose()
        }
      }}
    >
      <DialogContent
        scrollable
        density={group ? 'default' : 'compact'}
        className={
          group
            ? 'sm:max-w-md'
            : 'w-[calc(100%-2rem)] max-w-md grid-rows-[auto_auto_auto_minmax(3.5rem,1fr)] sm:max-w-md'
        }
        {...(!group && { 'aria-describedby': undefined })}
      >
        <DialogHeader className={group ? undefined : 'shrink-0 text-left'}>
          <DialogTitle size={group ? 'default' : 'compact'} className={group ? undefined : 'mr-6'}>
            {group
              ? t('bots.groups.manageMembers', 'Manage members')
              : t('bots.groups.newGroup', 'New group')}
          </DialogTitle>
          {group ? (
            <DialogDescription>
              {t('bots.groups.dialogDescription', 'Bots in a group share one room.')}
            </DialogDescription>
          ) : null}
        </DialogHeader>
        {group ? (
          <div className="flex h-32 items-center justify-center">
            <BotGroupFaceCluster members={picked} />
          </div>
        ) : null}
        <div className={group ? undefined : '-mb-2.5 shrink-0'}>
          <div className={group ? undefined : 'flex items-center gap-2'}>
            {!group ? (
              <div className="grid size-9.5 shrink-0 place-items-center rounded-md border border-input bg-input/30">
                <BotGroupFaceCluster members={picked} compact />
              </div>
            ) : null}
            <Label htmlFor="bot-group-name" className="sr-only">
              {t('bots.groups.name', 'Name')}
            </Label>
            <Input
              id="bot-group-name"
              variant={group ? 'heading' : 'name'}
              autoFocus={!group}
              autoComplete="off"
              spellCheck={false}
              value={name}
              maxLength={BOT_GROUP_NAME_MAX_LENGTH}
              placeholder={t('bots.groups.namePlaceholder', 'Name your group')}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (!takeSuggestionOnTab(event, suggestion, setName) && event.key === 'Enter') {
                  void save()
                }
              }}
            />
          </div>
          <BotNameSuggestion suggestion={suggestion} onTake={setName} compact={!group} />
        </div>
        {/* Size the picker in the dialog grid so a wrapped error still leaves room to scroll it. */}
        <div className={group ? undefined : 'contents'}>
          <div className={group ? undefined : '-mb-2 grid gap-1.5'}>
            <div
              className={
                group
                  ? 'mb-2 flex items-center justify-between'
                  : 'flex items-center justify-between gap-2'
              }
            >
              <Label id="bot-group-members">{t('bots.groups.members', 'Members')}</Label>
              <span className="text-xs text-muted-foreground tabular-nums">
                {selected.length > 0
                  ? t('bots.groups.picked', '{{count}} picked', { count: selected.length })
                  : null}
              </span>
            </div>
            {showFilter ? (
              <BotPickFilter
                value={query}
                onChange={setQuery}
                onFocusChange={group ? undefined : setFilterFocused}
                compact={!group}
              />
            ) : null}
          </div>
          <BotPickRows role="group" labelledBy="bot-group-members" compact={!group}>
            {!group && showFilter ? (
              <p
                role="status"
                aria-atomic="true"
                className={noMatches ? 'px-2 py-1.5 text-xs text-muted-foreground' : 'sr-only'}
              >
                {noMatches ? t('bots.search.noMatches', 'No matches') : null}
              </p>
            ) : null}
            {shownByHost
              ? [...shownByHost].map(([hostId, bots]) => (
                  <BotGroupMemberHostGroup
                    key={hostId}
                    hostId={hostId}
                    showLabel={manyHosts}
                    renderMembers={(hostLabel) => bots.map((bot) => renderMember(bot, hostLabel))}
                  />
                ))
              : shownBots.map((bot) => renderMember(bot))}
          </BotPickRows>
          {someElsewhere ? (
            <p id="bot-group-same-computer" className="mt-2 text-xs text-muted-foreground">
              {canMix
                ? t(
                    'bots.groups.pairedComputersOnly',
                    'Groups can add bots only from paired computers.'
                  )
                : t('bots.groups.sameComputer', 'Bots in a group must be on the same computer.')}
            </p>
          ) : null}
        </div>
        {removedDefault ? (
          <p className="text-xs text-muted-foreground">
            {t(
              'bots.groups.removingDefault',
              'Removing {{name}} changes Replies to Only when mentioned.',
              { name: defaultName }
            )}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <DialogFooter
          className={
            group ? 'items-center' : 'shrink-0 flex-row flex-wrap items-center justify-end'
          }
        >
          {group ? (
            <Button
              variant="ghost-destructive"
              size="sm"
              className="mr-auto"
              disabled={saving}
              onClick={() =>
                void deleteGroup(group).then((deleted) => {
                  if (deleted) {
                    onClose()
                  }
                })
              }
            >
              {t('bots.groups.deleteGroup', 'Delete group')}
            </Button>
          ) : null}
          {missing ? (
            <span className="mr-auto text-xs text-muted-foreground">{missing}</span>
          ) : null}
          {group ? (
            actions
          ) : (
            <div className="ml-auto flex max-w-full items-center gap-2">{actions}</div>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Opens a group just made. It exists now, so a failed open is a toast with Retry: pressing
 *  Create again would make a second group. */
function openCreatedGroup(group: BotGroup): void {
  void openBotGroup(group).catch((error: unknown) =>
    toast.error(
      translate('bots.groups.createdNotOpened', 'Created “{{name}}”, but couldn’t open it.', {
        name: group.name
      }),
      {
        id: `bot-group-open:${group.id}`,
        description: botErrorText(error),
        // Time to read which computer and reach Retry.
        duration: 10000,
        action: {
          label: translate('bots.groups.retryOpen', 'Retry'),
          onClick: () => openCreatedGroup(group)
        }
      }
    )
  )
}

/** The shared suggestion, in this client's words. */
export function suggestGroupName(names: readonly string[]): string | null {
  const suggestion = botGroupNameSuggestion(names)
  if (!suggestion) {
    return null
  }
  const text =
    suggestion.key === 'suggestTwo'
      ? translate('bots.groups.suggestTwo', '{{a}} & {{b}}', suggestion.values)
      : suggestion.key === 'suggestThree'
        ? translate('bots.groups.suggestThree', '{{a}}, {{b}} & {{c}}', suggestion.values)
        : translate('bots.groups.suggestMore', '{{a}}, {{b}} & {{count}} more', suggestion.values)
  return text.slice(0, BOT_GROUP_NAME_MAX_LENGTH)
}

function missingText(missing: ReturnType<typeof botGroupMissing>): string | null {
  return missing === 'pickTwo'
    ? translate('bots.groups.pickTwo', 'Pick 2 or more bots')
    : missing === 'pickOne'
      ? translate('bots.groups.pickOne', 'Pick a bot')
      : missing === 'nameIt'
        ? translate('bots.groups.nameIt', 'Name the group')
        : null
}
