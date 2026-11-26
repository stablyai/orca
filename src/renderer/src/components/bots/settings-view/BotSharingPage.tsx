// An agent's sharing, in two groups. Teammates use this agent: the same people list as the Share
// dialog. Copy link lets anyone make their own copy: Create copy link, or its live link with the copy
// icon and ⋯ (Update link in place, Change what's included… in the copy dialog, Stop sharing…).
import { useState } from 'react'
import {
  ExternalLink,
  Link2,
  Loader2,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  Share2,
  Trash2,
  UserPlus,
  Users
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { uiDateTimeFormat } from '@/i18n/ui-intl-formatters'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import { useTeamSharingOffered } from '@/runtime/hosts/shared-bot-hosts/shared-bot-host-catalog'
import { useAppStore } from '@/store'
import type { Bot } from '../../../../../shared/bot-types'
import { useOrcaCloudSignedOut } from '../orca-cloud-signed-out'
import { BotShareOfflineRow } from '../sharing/BotShareDialog'
import { BotSharePreview } from '../sharing/BotShareFlow'
import { updateBotShareInPlace } from '../sharing/bot-share-update-in-place'
import { BotShareStopDialog } from '../sharing/BotShareStopDialog'
import { ShareLinkCopyButton } from '../sharing/ShareLinkCopyButton'
import { useBotShareLink, type BotShareLink, type LinkRead } from '../sharing/use-bot-share-link'
import { TeamShareAddField } from '../team-share/BotTeamShareAddField'
import { TeamSharePeopleList, TeamShareRowsInset } from '../team-share/BotTeamShareRows'
import { useBotTeamShareList } from '../team-share/use-bot-team-share-list'
import { useBotHostLabel } from '../use-bot-host-label'
import type { BotSettingsPage } from './bot-settings-place'
import { botSharingState, botSharingValue } from './bot-sharing-state'
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
  const [open, setOpen] = useState<'dialog' | 'stop' | null>(null)
  // The link was just updated in place, so its caption says just now.
  const [updatedHere, setUpdatedHere] = useState(false)
  const [updating, setUpdating] = useState(false)
  const t = useTranslate()
  const link = linkState.read.kind === 'read' ? linkState.read.link : null
  const update = async (current: BotShareLink): Promise<void> => {
    setUpdating(true)
    const result = await updateBotShareInPlace(bot, current)
    setUpdating(false)
    switch (result.kind) {
      case 'updated':
        linkState.setLink(result.link)
        setUpdatedHere(true)
        return
      case 'upToDate':
        toast.message(t('bots.sharingPage.alreadyUpToDate', 'The link is already up to date'))
        return
      case 'secret':
        // The dialog shows the secret and where it is.
        setOpen('dialog')
        return
      case 'failed':
        toast.error(result.error)
        if (result.stale) {
          linkState.reread()
        }
    }
  }
  return (
    <>
      {useTeamSharingOffered() ? <BotTeammatesGroup bot={bot} /> : null}
      <BotShareLinkView
        read={linkState.read}
        reread={linkState.reread}
        otherLinks={linkState.otherLinks}
        updatedHere={updatedHere}
        updating={updating}
        onCreate={() => setOpen('dialog')}
        onUpdate={() => link && void update(link)}
        onChangeIncluded={() => setOpen('dialog')}
        onStop={() => setOpen('stop')}
      />
      {open === 'dialog' ? (
        <BotSharePreview
          bot={bot}
          linkState={linkState}
          onClose={() => setOpen(null)}
          onChanged={() => setUpdatedHere(false)}
        />
      ) : null}
      {open === 'stop' && link ? (
        <BotShareStopDialog
          name={bot.name}
          shareId={link.shareId}
          botId={bot.id}
          onStopped={() => {
            setOpen(null)
            setUpdatedHere(false)
            linkState.setLink(null)
          }}
          onCancel={() => setOpen(null)}
        />
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

const SHORT_DATE: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' }

/** No link: one Create copy link row. A link: its URL with the copy icon and ⋯, and a caption under it. */
function BotShareLinkView({
  read,
  reread,
  otherLinks,
  updatedHere,
  updating,
  onCreate,
  onUpdate,
  onChangeIncluded,
  onStop
}: {
  read: LinkRead
  reread: () => void
  otherLinks: boolean
  updatedHere: boolean
  updating: boolean
  onCreate: () => void
  onUpdate: () => void
  onChangeIncluded: () => void
  onStop: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const intlLocale = useIntlLocale()
  const openSettingsTarget = useAppStore((state) => state.openSettingsTarget)
  const openSettingsPage = useAppStore((state) => state.openSettingsPage)
  const title = t('bots.sharingPage.copyLink', 'Copy link')
  if (read.kind === 'offline') {
    return <BotShareOfflineRow title={title} error={read.error} onRetry={reread} />
  }
  if (read.kind === 'loading') {
    return (
      <SettingsInsetGroup title={title}>
        <SettingsInsetRow
          icon={<Loader2 className="animate-spin" />}
          title={t('bots.share.loadingLinks', 'Loading shared links…')}
          muted
        />
      </SettingsInsetGroup>
    )
  }
  // Signed out reads as no link: Create copy link opens the copy dialog, which asks to sign in.
  const link = read.kind === 'read' ? read.link : null
  if (!link) {
    return (
      <SettingsInsetGroup title={title}>
        <SettingsInsetRow
          icon={<Link2 />}
          title={t('bots.sharingPage.createCopyLink', 'Create copy link')}
          onOpen={onCreate}
        />
      </SettingsInsetGroup>
    )
  }
  const updatedAt = link.updatedAt ? new Date(link.updatedAt) : null
  const updated = updating
    ? t('bots.share.updating', 'Updating…')
    : updatedHere
      ? t('bots.share.updatedJustNow', 'Updated just now')
      : updatedAt && !Number.isNaN(updatedAt.getTime())
        ? t('bots.share.updatedAt', 'Updated {{date}}', {
            date: uiDateTimeFormat(SHORT_DATE, intlLocale).format(updatedAt)
          })
        : null
  const caption = [
    t('bots.sharingPage.anyoneCanCopy', 'Anyone with the link can make a copy'),
    updated
  ]
    .filter(Boolean)
    .join(' · ')
  const moreLabel = t('bots.sharingPage.linkActions', 'Link actions')
  return (
    <SettingsInsetGroup title={title} foot={caption}>
      <div
        data-row-icon=""
        className="flex min-h-11 min-w-0 items-center gap-2.5 py-1.5 pr-1.5 pl-3"
      >
        <Link2 className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-mono text-xs">
          {link.url.replace(/^https:\/\//, '')}
        </span>
        <ShareLinkCopyButton
          onCopy={() =>
            void window.api.ui
              .writeClipboardText(link.url)
              .then(() => toast.success(t('bots.share.linkCopied', 'Link copied')))
          }
        />
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label={moreLabel} disabled={updating}>
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent side="top">{moreLabel}</TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={onUpdate}>
              <RefreshCw />
              {t('bots.share.updateLink', 'Update link')}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onChangeIncluded}>
              <Pencil />
              {t('bots.sharingPage.changeIncluded', 'Change what’s included…')}
            </DropdownMenuItem>
            <DropdownMenuItem variant="destructive" onSelect={onStop}>
              <Trash2 />
              {t('bots.sharingPage.stopSharing', 'Stop sharing…')}
            </DropdownMenuItem>
            {otherLinks ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onSelect={() => {
                    openSettingsTarget({ pane: 'shared-links', repoId: null })
                    openSettingsPage()
                  }}
                >
                  <ExternalLink />
                  {t('bots.sharingPage.allYourLinks', 'All your links')}
                </DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </SettingsInsetGroup>
  )
}
