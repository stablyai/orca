// Settings → Shared links → Bots: one row per live bot link, with the same actions as its dialog.
import { useCallback, useEffect, useState } from 'react'
import { ChevronRight, Clipboard, Link2Off, MoreHorizontal, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { uiDateTimeFormat } from '@/i18n/ui-intl-formatters'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import { useBots } from '@/lib/bot-catalog'
import type { Bot } from '../../../../../shared/bot-types'
import { botPackageName, type BotOwnedShare } from '../../../../../shared/bots/bot-share-status'
import { BotAvatar } from '../BotAvatar'
import { botShareErrorMessage } from './bot-share-error-copy'
import { listBotShares } from './bot-share-rpc'
import { BotShareFlow } from './BotShareFlow'
import type { BotShareStart } from './use-bot-share-link'
import { BotShareStopDialog } from './BotShareStopDialog'

const DATE: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' }

function BotSharedLinkRow({
  share,
  bot,
  onAct
}: {
  share: BotOwnedShare
  bot: Bot | null
  onAct: (start: BotShareStart) => void
}): React.JSX.Element {
  const t = useTranslate()
  const intlLocale = useIntlLocale()
  const created = new Date(share.createdAt)
  // A link whose bot isn't here goes by the name it was shared under.
  const name = bot?.name ?? share.displayName ?? share.name
  const copy = async (): Promise<void> => {
    await window.api.ui.writeClipboardText(share.url)
    toast.success(t('bots.share.linkCopied', 'Link copied'))
  }
  return (
    <li className="flex items-center gap-3 px-3 py-2">
      {bot ? <BotAvatar bot={bot} className="size-6 rounded-md" /> : null}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{name}</span>
        <span className="block truncate font-mono text-[11px] text-muted-foreground">
          {share.url}
        </span>
      </span>
      <span className="shrink-0 text-[11px] text-muted-foreground">
        {Number.isNaN(created.getTime()) ? '' : uiDateTimeFormat(DATE, intlLocale).format(created)}
      </span>
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        aria-label={t('bots.share.copyLink', 'Copy link')}
        onClick={() => void copy()}
      >
        <Clipboard />
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label={t('bots.share.moreActions', 'More actions for {{name}}', { name })}
          >
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {/* Update link rebuilds from the bot, so it needs the bot here; stopping needs only the link. */}
          {bot ? (
            <DropdownMenuItem onSelect={() => onAct('update')}>
              <RefreshCw />
              {t('bots.share.updateLink', 'Update link')}
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem variant="destructive" onSelect={() => onAct('stop')}>
            <Link2Off />
            {t('bots.share.stopSharing', 'Stop sharing')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {bot ? (
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label={t('bots.share.openLink', 'Open {{name}}’s link', { name })}
          onClick={() => onAct('open')}
        >
          <ChevronRight />
        </Button>
      ) : null}
    </li>
  )
}

export function BotSharedLinksList(): React.JSX.Element {
  const t = useTranslate()
  const bots = useBots()
  const [shares, setShares] = useState<BotOwnedShare[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [acting, setActing] = useState<{
    share: BotOwnedShare
    bot: Bot | null
    start: BotShareStart
  } | null>(null)

  const load = useCallback(() => {
    setError(null)
    listBotShares().then(setShares, (cause: unknown) => setError(botShareErrorMessage(cause)))
  }, [])
  useEffect(load, [load])

  if (error) {
    return (
      <p className="rounded-md border border-border p-3 text-xs text-destructive" role="alert">
        {error}
      </p>
    )
  }
  if (!shares) {
    return (
      <p className="rounded-md border border-border p-3 text-xs text-muted-foreground">
        {t('bots.share.loadingLinks', 'Loading shared links…')}
      </p>
    )
  }
  if (shares.length === 0) {
    return (
      <p className="rounded-md border border-border p-3 text-xs text-muted-foreground">
        {t('bots.share.noLinks', 'No bot links. Share a bot from its settings.')}
      </p>
    )
  }
  // Canonical links first; older builds' links stay listed, so nothing is stopped silently.
  const sorted = [...shares].sort((a, b) => Number(b.canonical) - Number(a.canonical))
  return (
    <>
      <ul className="divide-y divide-border rounded-md border border-border">
        {sorted.map((share) => {
          const bot = bots.find((entry) => botPackageName(entry.id) === share.name) ?? null
          return (
            <BotSharedLinkRow
              key={share.id}
              share={share}
              bot={bot}
              onAct={(start) => setActing({ share, bot, start })}
            />
          )
        })}
      </ul>
      {acting && !acting.bot ? (
        <BotShareStopDialog
          name={acting.share.displayName ?? acting.share.name}
          shareId={acting.share.id}
          onStopped={() => {
            setActing(null)
            load()
          }}
          onCancel={() => setActing(null)}
        />
      ) : acting?.bot ? (
        <BotShareFlow
          bot={acting.bot}
          start={acting.start}
          shareId={acting.share.id}
          onChanged={load}
          onClose={() => setActing(null)}
        />
      ) : null}
    </>
  )
}
