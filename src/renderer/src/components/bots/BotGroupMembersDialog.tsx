import { translate } from '@/i18n/i18n'
import { botRefKey, callBotRpc } from '@/lib/bot-hosts'
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
import type { ExecutionHostId } from '../../../../shared/execution-host/execution-host'
import { BotAvatar } from './BotAvatar'
import { useBotPurposes } from './use-bot-purposes'
import { BotNameSuggestion, takeSuggestionOnTab } from './BotNameSuggestion'
import { BotPickFilter, BotPickRow, BotPickRows, FILTER_FROM, filterByName } from './BotPickList'
import { BotGroupFaceCluster } from './BotGroupFaceCluster'
import {
  BOT_GROUP_NAME_MAX_LENGTH,
  botGroupMissing,
  botGroupNameSuggestion,
  botGroupPickOrder,
  botGroupUnchanged
} from '../../../../shared/bots/bot-group-pick'
import { useBotGroupDelete } from './use-bot-group-delete'

export function BotGroupMembersDialog({
  group,
  onClose
}: {
  group?: BotGroup
  onClose: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const allBots = useBots()
  // A group lives on one computer: once a member is picked, only that computer's bots can join.
  const [pickHost, setPickHost] = useState<ExecutionHostId | null>(group?.hostId ?? null)
  const bots = useMemo(
    () => (pickHost ? allBots.filter((bot) => bot.hostId === pickHost) : allBots),
    [allBots, pickHost]
  )
  const [name, setName] = useState(group?.name ?? '')
  // In pick order: the picture and the suggested name follow it.
  const [selected, setSelected] = useState<string[]>(
    () => group?.members.map((member) => member.botId) ?? []
  )
  const [query, setQuery] = useState('')
  const [popped, setPopped] = useState<string | null>(null)
  const purposes = useBotPurposes()
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const deleteGroup = useBotGroupDelete()
  const removedDefault =
    group?.replyMode.kind === 'bot' && !selected.includes(group.replyMode.botId)
  const defaultBotId = group?.replyMode.kind === 'bot' ? group.replyMode.botId : null
  const defaultName = bots.find((bot) => bot.id === defaultBotId)?.name
  const savedIds = group?.members.map((member) => member.botId) ?? []
  const picked = botGroupPickOrder(savedIds, selected).flatMap(
    (id) => bots.find((bot) => bot.id === id) ?? []
  )
  const suggestion = name ? null : suggestGroupName(picked.map((bot) => bot.name))
  const missing = missingText(botGroupMissing(picked.length, name, group !== undefined))
  // Editing saves only a real change: a new name, or other members or order.
  const unchanged =
    group !== undefined &&
    botGroupUnchanged(
      { name: group.name, botIds: savedIds },
      name,
      picked.map((bot) => bot.id)
    )
  const shownBots = filterByName(bots, query, (bot) => bot.name)
  const toggle = (bot: Bot) => {
    const { id } = bot
    const on = selected.includes(id)
    const next = on ? selected.filter((x) => x !== id) : [...selected, id]
    setSelected(next)
    setPopped(on ? null : id)
    if (!group) {
      setPickHost(next.length > 0 ? bot.hostId : null)
    }
  }
  const save = async () => {
    if (saving || missing || unchanged) {
      return
    }
    setSaving(true)
    try {
      // A new group lives on its members' host.
      const host = group ?? picked[0]
      const { group: saved } = await callBotRpc<{ group: BotGroup }>(
        host,
        group ? 'bots.groups.update' : 'bots.groups.create',
        group
          ? {
              groupId: group.id,
              revision: group.revision,
              name: name.trim(),
              botIds: picked.map((bot) => bot.id)
            }
          : { name: name.trim(), botIds: picked.map((bot) => bot.id) }
      )
      await refreshBotGroups()
      if (!group) {
        await openBotGroup(saved)
      }
      onClose()
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error))
      setSaving(false)
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) {
          onClose()
        }
      }}
    >
      <DialogContent scrollable className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {group
              ? t('bots.groups.manageMembers', 'Manage members')
              : t('bots.groups.newGroup', 'New group')}
          </DialogTitle>
          <DialogDescription>
            {t('bots.groups.dialogDescription', 'Bots in a group share one room.')}
          </DialogDescription>
        </DialogHeader>
        <div className="flex h-32 items-center justify-center">
          <BotGroupFaceCluster members={picked} />
        </div>
        <div>
          <Label htmlFor="bot-group-name" className="sr-only">
            {t('bots.groups.name', 'Name')}
          </Label>
          <Input
            id="bot-group-name"
            variant="heading"
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
          <BotNameSuggestion suggestion={suggestion} onTake={setName} />
        </div>
        <div>
          <div className="mb-2 flex items-center justify-between">
            <Label id="bot-group-members">{t('bots.groups.members', 'Members')}</Label>
            <span className="text-xs text-muted-foreground tabular-nums">
              {selected.length > 0
                ? t('bots.groups.picked', '{{count}} picked', { count: selected.length })
                : null}
            </span>
          </div>
          {bots.length > FILTER_FROM ? <BotPickFilter value={query} onChange={setQuery} /> : null}
          <BotPickRows role="group" labelledBy="bot-group-members">
            {shownBots.map((bot) => (
              <MemberRow
                key={botRefKey(bot)}
                bot={bot}
                purpose={purposes.get(botRefKey(bot)) ?? null}
                on={selected.includes(bot.id)}
                pop={popped === bot.id}
                disabled={saving}
                onToggle={() => toggle(bot)}
              />
            ))}
          </BotPickRows>
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
        <DialogFooter className="items-center">
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
        </DialogFooter>
      </DialogContent>
    </Dialog>
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

function MemberRow({
  bot,
  purpose,
  on,
  pop,
  disabled,
  onToggle
}: {
  bot: Bot
  purpose: string | null
  on: boolean
  pop: boolean
  disabled: boolean
  onToggle: () => void
}): React.JSX.Element {
  return (
    <BotPickRow
      role="checkbox"
      aria-checked={on}
      disabled={disabled}
      // A pointer pick leaves focus in the name field, so its Tab suggestion still works.
      onMouseDown={(event) => event.preventDefault()}
      onClick={onToggle}
      picture={<BotAvatar bot={bot} className="size-7 rounded-lg text-sm" />}
      name={bot.name}
      detail={purpose}
      on={on}
      pop={pop}
    />
  )
}
