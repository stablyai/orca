// The bot's sharing, as state: not shared with Share bot…, or its live link with Copy link and Manage
// sharing…. Both open the one Share dialog, which holds Publish, Update link and Stop sharing.
import { useState } from 'react'
import { Copy, ExternalLink, Link2, Loader2, Share2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { uiDateTimeFormat } from '@/i18n/ui-intl-formatters'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store'
import type { Bot } from '../../../../../shared/bot-types'
import { useOrcaCloudSignedOut } from '../orca-cloud-signed-out'
import { BotShareOfflineRow, BotShareUpdatedLine } from '../sharing/BotShareDialog'
import { BotSharePreview } from '../sharing/BotShareFlow'
import { useBotShareLink, type LinkRead } from '../sharing/use-bot-share-link'
import type { BotSettingsPage } from './bot-settings-place'
import { SettingsInsetGroup, SettingsInsetRow } from './BotSettingsRows'

const SHORT_DATE: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' }

/** The bot's sharing as a row: whether it is shared, opening Settings › Sharing. */
export function BotSharingGroup({
  bot,
  open
}: {
  bot: Bot
  open: (page: BotSettingsPage) => void
}): React.JSX.Element {
  const t = useTranslate()
  const intlLocale = useIntlLocale()
  const { read } = useBotShareLink(bot.id, undefined, useOrcaCloudSignedOut())
  const link = read.kind === 'read' ? read.link : undefined
  const updated = link?.updatedAt ? new Date(link.updatedAt) : null
  const detail =
    link === null
      ? t('bots.share.notShared', 'Not shared')
      : updated && !Number.isNaN(updated.getTime())
        ? t('bots.share.sharedUpdated', 'Shared · updated {{date}}', {
            date: uiDateTimeFormat(SHORT_DATE, intlLocale).format(updated)
          })
        : undefined
  return (
    <SettingsInsetGroup>
      <SettingsInsetRow
        icon={link ? <Link2 /> : <Share2 />}
        title={t('bots.settingsView.sharing', 'Sharing')}
        detail={detail}
        page="sharing"
        onOpen={() => open('sharing')}
      />
    </SettingsInsetGroup>
  )
}

export function BotSharingPage({ bot }: { bot: Bot }): React.JSX.Element {
  const linkState = useBotShareLink(bot.id, undefined, useOrcaCloudSignedOut())
  const { read, reread } = linkState
  const [sharing, setSharing] = useState(false)
  return (
    <>
      <BotShareLinkView bot={bot} read={read} reread={reread} onShare={() => setSharing(true)} />
      {sharing ? (
        <BotSharePreview bot={bot} linkState={linkState} onClose={() => setSharing(false)} />
      ) : null}
    </>
  )
}

function BotShareLinkView({
  bot,
  read,
  reread,
  onShare
}: {
  bot: Bot
  read: LinkRead
  reread: () => void
  onShare: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const openSettingsTarget = useAppStore((state) => state.openSettingsTarget)
  const openSettingsPage = useAppStore((state) => state.openSettingsPage)
  const manageLinks = (
    <SettingsInsetGroup>
      <SettingsInsetRow
        icon={<ExternalLink />}
        title={t('bots.share.manageLinks', 'Manage links')}
        onOpen={() => {
          openSettingsTarget({ pane: 'shared-links', repoId: null })
          openSettingsPage()
        }}
      />
    </SettingsInsetGroup>
  )
  const shareButton = (label: string) => (
    <Button variant="outline" size="sm" onClick={onShare}>
      {label}
    </Button>
  )
  const link = read.kind === 'read' ? read.link : null
  if (!link) {
    return (
      <>
        <SettingsInsetGroup>
          <SettingsInsetRow
            icon={<Share2 />}
            title={
              read.kind === 'read'
                ? t('bots.share.notShared', 'Not shared')
                : t('bots.settingsView.sharing', 'Sharing')
            }
            detail={t('bots.share.description', 'Anyone with the link can make a copy.')}
            wrapDetail
            wrapEnd
            end={shareButton(t('bots.share.shareBot', 'Share bot…'))}
          />
        </SettingsInsetGroup>
        {read.kind === 'offline' ? (
          <BotShareOfflineRow error={read.error} onRetry={reread} />
        ) : null}
        {read.kind === 'loading' ? (
          <SettingsInsetGroup>
            <SettingsInsetRow
              icon={<Loader2 className="animate-spin" />}
              title={t('bots.share.loadingLinks', 'Loading shared links…')}
              muted
            />
          </SettingsInsetGroup>
        ) : null}
        {read.kind === 'read' ? manageLinks : null}
      </>
    )
  }
  const copy = async (): Promise<void> => {
    await window.api.ui.writeClipboardText(link.url)
    toast.success(t('bots.share.linkCopied', 'Link copied'))
  }
  return (
    <>
      <SettingsInsetGroup>
        <div
          data-row-icon=""
          className="flex min-w-0 flex-wrap items-start gap-2.5 py-2 pr-2.5 pl-3 text-[13px]"
        >
          <Link2 className="mt-px size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1">
            <span className="block truncate leading-[18px] font-medium">
              {t('bots.share.isShared', '{{name}} is shared', { name: bot.name })}
            </span>
            <span className="block text-xs leading-4 break-words text-muted-foreground">
              <BotShareUpdatedLine updatedAt={link.updatedAt} upToDate={null} />
            </span>
            <span className="mt-0.5 block truncate font-mono text-xs leading-4 text-muted-foreground">
              {link.url.replace(/^https:\/\//, '')}
            </span>
          </span>
          <div className="flex basis-full gap-1.5 pt-1.5 pl-6.5">
            <Button variant="outline" size="sm" onClick={() => void copy()}>
              <Copy />
              {t('bots.share.copyLink', 'Copy link')}
            </Button>
            {shareButton(t('bots.share.manageSharing', 'Manage sharing…'))}
          </div>
        </div>
      </SettingsInsetGroup>
      {manageLinks}
    </>
  )
}
