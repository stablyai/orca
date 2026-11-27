// The composer under-row's Slack item: whether this chat's messages also post to its Slack thread,
// with the switch, who sees them, and Open in Slack in its menu.
import { useState } from 'react'
import { ChevronDown, ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { SlackIcon } from '@/components/icons/SlackIcon'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { openOwnedHttpLink } from '@/lib/browser/navigation/http-link-routing'
import { openBotConnectorsTab } from '@/components/bots/bot-settings-open'
import type { SlackMirrorStatus } from '../../../../../shared/connectors/connector-slack-mirror-contract'
import {
  slackMirrorView,
  slackPlaceOf,
  slackThreadUrl,
  type SlackMirrorCopy
} from '../../../../../shared/connectors/slack-mirror-state'
import { useNativeChatSlackMirrorContext } from './native-chat-slack-mirror'

const FOOTER_TEXT =
  'min-w-0 overflow-x-clip text-ellipsis text-2xs whitespace-nowrap [text-box:trim-both_cap_alphabetic]'

export function useSlackMirrorCopy(): (copy: SlackMirrorCopy) => string {
  const t = useTranslate()
  return (copy) => t(copy.key, copy.text, copy.values)
}

export function NativeChatSlackMirrorItem(): React.JSX.Element | null {
  const mirror = useNativeChatSlackMirrorContext()
  const t = useTranslate()
  const say = useSlackMirrorCopy()
  const [status, setStatus] = useState<SlackMirrorStatus | null>(null)
  if (!mirror) {
    return null
  }
  const view = slackMirrorView(mirror.link, mirror.botName, status ?? undefined)
  const url = slackThreadUrl(mirror.link.externalId)
  const label = say(view.label)
  return (
    <DropdownMenu
      modal={false}
      onOpenChange={(open) => {
        if (open) {
          void mirror.status().then((read) => read && setStatus(read))
        }
      }}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="h-5.5 min-w-0 max-w-64 shrink justify-start"
              aria-label={label}
            >
              <SlackIcon
                className={cn('size-3 shrink-0', !view.on && 'opacity-60 grayscale')}
                aria-hidden
              />
              {/* Narrow panes show the short form: the icon and #eng. */}
              <span className={cn(FOOTER_TEXT, 'hidden @sm:inline')}>{label}</span>
              <span className={cn(FOOTER_TEXT, '@sm:hidden')}>
                {view.on ? say(view.short) : say(view.label)}
              </span>
              <ChevronDown className="size-3 shrink-0" aria-hidden />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={4}>
          {view.on
            ? t(
                'components.native-chat.slackMirror.tooltipOn',
                "Your messages and {{bot}}'s replies also post to this Slack thread",
                { bot: mirror.botName }
              )
            : t('components.native-chat.slackMirror.tooltipOff', 'Your messages stay in Orca')}
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="start" side="top" sideOffset={6} className="w-72">
        <DropdownMenuLabel>
          <span className="flex min-w-0 items-center gap-1.5">
            <SlackIcon className="size-3 shrink-0" aria-hidden />
            <span className="min-w-0 truncate">{say(view.heading)}</span>
          </span>
        </DropdownMenuLabel>
        <div className="px-2 pb-1.5">
          <label className="flex items-center justify-between gap-3 py-1 text-sm">
            <span>{t('components.native-chat.slackMirror.switch', 'Post this chat to Slack')}</span>
            <Switch
              checked={view.on}
              disabled={view.blocked !== null}
              onCheckedChange={(on) => void mirror.setOn(on)}
            />
          </label>
          <p className="text-xs leading-4 text-muted-foreground">{say(view.detail)}</p>
        </div>
        <DropdownMenuSeparator />
        {view.updateNeeded ? (
          <DropdownMenuItem // The bot's Slack card runs the update, as it does from Settings.
            onSelect={() => {
              const bot = mirror.bot()
              if (bot) {
                const place = slackPlaceOf(mirror.link.externalId)
                openBotConnectorsTab(bot, place ? `slack:${place.teamId}` : undefined)
              }
            }}
          >
            {t('bots.slack.connection.update', 'Update in Slack')}
          </DropdownMenuItem>
        ) : null}
        {url ? (
          <DropdownMenuItem
            onSelect={() =>
              openOwnedHttpLink(url, { sourceOwner: { kind: 'local' }, forceSystemBrowser: true })
            }
          >
            <span className="flex-1">
              {t('components.native-chat.connectorAsker.open', 'Open in {{source}}', {
                source: 'Slack'
              })}
            </span>
            <ExternalLink className="size-3.5 text-muted-foreground" aria-hidden />
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
