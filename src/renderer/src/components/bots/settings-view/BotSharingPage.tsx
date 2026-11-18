// The bot's sharing, as state: not shared with Share bot…, or its live link with Copy link and Manage
// sharing…. Both open the one Share dialog, which holds Publish, Update link and Stop sharing.
import { useCallback, useEffect, useState } from 'react'
import { Copy, ExternalLink, Link2, Loader2, Share2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { uiDateTimeFormat } from '@/i18n/ui-intl-formatters'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store'
import type { Bot } from '../../../../../shared/bot-types'
import { botShareStatusOf } from '../../../../../shared/bots/bot-share-status'
import { botErrorMessage } from '../bot-presentation'
import { OrcaCloudSignInLine, orcaCloudSignInReason } from '../orca-cloud-sign-in'
import { useOrcaCloudSignedOut } from '../orca-cloud-signed-out'
import { listBotShares } from '../sharing/bot-share-rpc'
import { BotShareUpdatedLine } from '../sharing/BotShareDialog'
import { BotShareFlow } from '../sharing/BotShareFlow'
import { botShareLinkOf, type BotShareLink } from '../sharing/use-bot-share-link'
import type { BotSettingsPage } from './bot-settings-place'
import { SettingsInsetGroup, SettingsInsetRow } from './BotSettingsRows'

/** The bot's live link; undefined while it is read, null when it has none, an error when the read failed. */
export function useBotShareLinkRead(
  botId: string,
  skip = false
): {
  link: BotShareLink | null | undefined | { error: string }
  reread: () => void
} {
  const [link, setLink] = useState<BotShareLink | null | undefined | { error: string }>(undefined)
  const [version, setVersion] = useState(0)
  useEffect(() => {
    if (skip) {
      return
    }
    let live = true
    setLink(undefined)
    listBotShares(botId).then(
      (shares) => live && setLink(botShareLinkOf(botShareStatusOf(shares, botId))),
      (error: unknown) => live && setLink({ error: botErrorMessage(error) })
    )
    return () => {
      live = false
    }
  }, [botId, version, skip])
  const reread = useCallback(() => setVersion((current) => current + 1), [])
  return { link, reread }
}

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
  const { link } = useBotShareLinkRead(bot.id, useOrcaCloudSignedOut(bot.hostId))
  const updated = link && !('error' in link) && link.updatedAt ? new Date(link.updatedAt) : null
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
        icon={link && !('error' in link) ? <Link2 /> : <Share2 />}
        title={t('bots.settingsView.sharing', 'Sharing')}
        detail={detail}
        page="sharing"
        onOpen={() => open('sharing')}
      />
    </SettingsInsetGroup>
  )
}

export function BotSharingPage({ bot }: { bot: Bot }): React.JSX.Element {
  const signedOut = useOrcaCloudSignedOut()
  if (signedOut) {
    return (
      <SettingsInsetGroup>
        <OrcaCloudSignInLine className="px-3 py-3" text={orcaCloudSignInReason('share')} />
      </SettingsInsetGroup>
    )
  }
  return <BotShareLinkView bot={bot} />
}

function BotShareLinkView({ bot }: { bot: Bot }): React.JSX.Element {
  const t = useTranslate()
  const { link, reread } = useBotShareLinkRead(bot.id)
  const [sharing, setSharing] = useState(false)
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
  if (link && 'error' in link) {
    // Unread is not "not shared": say so, and read again on Retry.
    return (
      <SettingsInsetGroup>
        <SettingsInsetRow
          icon={<Share2 />}
          title={link.error}
          wrapDetail
          end={
            <Button variant="outline" size="sm" onClick={reread}>
              {t('settings.bots.retry', 'Retry')}
            </Button>
          }
        />
      </SettingsInsetGroup>
    )
  }
  if (link === undefined) {
    return (
      <SettingsInsetGroup>
        <SettingsInsetRow
          icon={<Loader2 className="animate-spin" />}
          title={t('bots.share.loadingLinks', 'Loading shared links…')}
          muted
        />
      </SettingsInsetGroup>
    )
  }
  const dialog = sharing ? (
    <BotShareFlow bot={bot} link={link} onClose={() => setSharing(false)} onChanged={reread} />
  ) : null
  const shareButton = (label: string) => (
    <Button variant="outline" size="sm" onClick={() => setSharing(true)}>
      {label}
    </Button>
  )
  if (!link) {
    return (
      <>
        <SettingsInsetGroup>
          <SettingsInsetRow
            icon={<Share2 />}
            title={t('bots.share.notShared', 'Not shared')}
            detail={t('bots.share.description', 'Anyone with the link can make a copy.')}
            wrapDetail
            wrapEnd
            end={shareButton(t('bots.share.shareBot', 'Share bot…'))}
          />
        </SettingsInsetGroup>
        {manageLinks}
        {dialog}
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
      {dialog}
    </>
  )
}
