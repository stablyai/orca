// An agent's sharing, in two groups. Teammates use this agent: the same people list as the Share
// dialog. Copy link lets anyone make their own copy: not shared with Send a copy…, or its live link
// with Copy link and Manage sharing…, both opening the one copy dialog.
import { useState } from 'react'
import { Copy, ExternalLink, Link2, Loader2, Share2, UserPlus, Users } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { useTeamSharingOffered } from '@/runtime/hosts/shared-bot-hosts/shared-bot-host-catalog'
import { useAppStore } from '@/store'
import type { Bot } from '../../../../../shared/bot-types'
import { useOrcaCloudSignedOut } from '../orca-cloud-signed-out'
import { BotShareOfflineRow, BotShareUpdatedLine } from '../sharing/BotShareDialog'
import { BotSharePreview } from '../sharing/BotShareFlow'
import { useBotShareLink, type LinkRead } from '../sharing/use-bot-share-link'
import { TeamShareAddField } from '../team-share/BotTeamShareAddField'
import { TeamSharePeopleList, TeamShareRowsInset } from '../team-share/BotTeamShareRows'
import { useBotTeamShareList } from '../team-share/use-bot-team-share-list'
import { useBotHostLabel } from '../use-bot-host-label'
import type { BotSettingsPage } from './bot-settings-place'
import { botNotShared, botSharingState, botSharingValue } from './bot-sharing-state'
import { SettingsInsetGroup, SettingsInsetRow } from './BotSettingsRows'

/** The agent's sharing as a row: its teammates' names, else On or Off, opening Settings › Sharing. */
export function BotSharingGroup({
  bot,
  open
}: {
  bot: Bot
  open: (page: BotSettingsPage) => void
}): React.JSX.Element {
  const t = useTranslate()
  const { read } = useBotShareLink(bot.id, undefined, useOrcaCloudSignedOut())
  const state = botSharingState(bot.shares, read.kind === 'read' ? read.link : undefined)
  return (
    <SettingsInsetGroup>
      <SettingsInsetRow
        icon={state.teammates.length > 0 ? <Users /> : state.link ? <Link2 /> : <Share2 />}
        title={t('bots.settingsView.sharing', 'Sharing')}
        value={botSharingValue(state, {
          on: t('bots.settingsView.sharingOn', 'On'),
          off: t('bots.settingsPage.off', 'Off')
        })}
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
      {useTeamSharingOffered() ? <BotTeammatesGroup bot={bot} /> : null}
      <BotShareLinkView bot={bot} read={read} reread={reread} onShare={() => setSharing(true)} />
      {sharing ? (
        <BotSharePreview bot={bot} linkState={linkState} onClose={() => setSharing(false)} />
      ) : null}
    </>
  )
}

const INSET_LIST_HAIRLINES =
  "[&>li+li]:relative [&>li+li]:before:pointer-events-none [&>li+li]:before:absolute [&>li+li]:before:top-0 [&>li+li]:before:right-0 [&>li+li]:before:left-14 [&>li+li]:before:border-t [&>li+li]:before:border-border [&>li+li]:before:content-['']"

function BotTeammatesGroup({ bot }: { bot: Bot }): React.JSX.Element {
  const t = useTranslate()
  const { connectorRows, ...list } = useBotTeamShareList(bot)
  const host = useBotHostLabel(bot.hostId) ?? t('bots.teamShare.thisComputer', 'this computer')
  return (
    <SettingsInsetGroup
      title={t('bots.sharingPage.teammates', 'Teammates')}
      // Room for the Add field's suggestions to open past the group.
      overflowVisible
      foot={t(
        'bots.sharingPage.teammatesFoot',
        'Runs on {{host}} with your accounts. You can see their chats with it, and each teammate sees only their own.',
        { host }
      )}
    >
      <div className="flex min-w-0 items-center gap-2.5 py-2 pr-2.5 pl-3">
        <UserPlus className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <TeamShareAddField {...list} />
        <Button
          variant="outline"
          size="sm"
          disabled={list.staged.length === 0 || list.sharing}
          onClick={list.onShare}
        >
          {t('bots.sharingPage.add', 'Add')}
        </Button>
      </div>
      <TeamShareRowsInset.Provider value>
        <TeamSharePeopleList {...list} className={INSET_LIST_HAIRLINES}>
          {connectorRows}
        </TeamSharePeopleList>
      </TeamShareRowsInset.Provider>
    </SettingsInsetGroup>
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
  const copyLink = t('bots.sharingPage.copyLink', 'Copy link')
  const link = read.kind === 'read' ? read.link : null
  if (!link) {
    const notShared = botNotShared(botSharingState(bot.shares, null))
    return (
      <>
        <SettingsInsetGroup title={copyLink}>
          <SettingsInsetRow
            icon={<Share2 />}
            title={
              read.kind !== 'read'
                ? t('bots.settingsView.sharing', 'Sharing')
                : notShared
                  ? t('bots.share.notShared', 'Not shared')
                  : t('bots.sharingPage.noCopyLink', 'No copy link')
            }
            detail={t('bots.share.description', 'Anyone with the link can make a copy.')}
            wrapDetail
            wrapEnd
            end={shareButton(t('bots.share.shareCopy', 'Send a copy…'))}
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
      <SettingsInsetGroup title={copyLink}>
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
