import { translate } from '@/i18n/i18n'
import { callBotGroupRpc } from '@/lib/bot-group-rpc'
import { useTranslate } from '@/i18n/use-translate'
import { useState } from 'react'
import { ChevronDown, Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useBots } from '@/lib/bot-catalog'
import type { BotGroup, BotGroupReplyMode } from '../../../../shared/bots/bot-group'
import {
  botGroupDraftAudience,
  formatBotGroupAudience
} from '../../../../shared/bots/bot-group-mentions'
import { toast } from 'sonner'
import { BotAvatar } from './BotAvatar'

export function BotGroupReplyPicker({
  group,
  draft,
  onChange
}: {
  group: BotGroup
  draft: string
  onChange: (group: BotGroup) => void
}): React.JSX.Element {
  const t = useTranslate()
  const [open, setOpen] = useState(false)
  const bots = useBots().filter(
    (bot) => bot.hostId === group.hostId && group.members.some((member) => member.botId === bot.id)
  )
  const mode = group.replyMode
  const label = formatBotGroupAudience(
    botGroupDraftAudience(draft, group, bots),
    group,
    bots,
    translate
  )
  const choose = async (replyMode: BotGroupReplyMode) => {
    try {
      const result = await callBotGroupRpc<{ group: BotGroup }>(group, 'bots.groups.update', {
        groupId: group.id,
        revision: group.revision,
        replyMode
      })
      // The host's bots-changed refreshes the catalog; the room takes the result now so its next send carries the new revision.
      onChange(result.group)
      setOpen(false)
    } catch (error) {
      toast.error(String(error))
    }
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="xs"
          aria-label={t('bots.groups.repliesValue', 'Replies: {{value0}}', {
            value0: label
          })}
          className="max-w-64"
        >
          <span className="text-chat-foreground-faint">
            {t('bots.groups.repliesPrefix', 'Replies:')}
          </span>
          <span className="truncate text-chat-foreground">{label}</span>
          <ChevronDown className="size-3" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-56">
        <div className="px-2 py-1.5 text-xs font-semibold text-muted-foreground">
          {t('bots.groups.whoAnswers', 'Who answers your messages')}
        </div>
        {bots.map((bot) => (
          <Button
            key={bot.id}
            variant="ghost"
            size="sm"
            className="w-full justify-start"
            onClick={() => void choose({ kind: 'bot', botId: bot.id })}
          >
            <BotAvatar bot={bot} className="size-5" />
            <span className="flex-1 truncate text-left">{bot.name}</span>
            {mode.kind === 'bot' && mode.botId === bot.id ? <Check className="size-4" /> : null}
          </Button>
        ))}
        {(['all', 'mentions'] as const).map((kind) => (
          <Button
            key={kind}
            variant="ghost"
            size="sm"
            className="w-full justify-start"
            onClick={() => void choose({ kind })}
          >
            <span className="flex-1 text-left">
              {kind === 'all'
                ? t('bots.groups.allBots', 'All bots')
                : t('bots.groups.onlyWhenMentioned', 'Only when mentioned')}
            </span>
            {mode.kind === kind ? <Check className="size-4" /> : null}
          </Button>
        ))}
      </PopoverContent>
    </Popover>
  )
}
