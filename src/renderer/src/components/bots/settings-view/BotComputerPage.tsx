// Where the bot runs, read-only: its computer, the Orca account that computer runs as, and its folder.
import { Copy, Folder, Laptop, Server, UserRound } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { useBotHostOrcaAccount, useBotHostOrcaAccountSettled } from '@/lib/bot-host-orca-account'
import { useBotHostOffline } from '@/lib/bot-host-views'
import { useAppStore } from '@/store'
import type { Bot } from '../../../../../shared/bot-types'
import { getLocalExecutionHostLabel } from '../../../../../shared/execution-host/execution-host'
import { botFolderDisplay } from '../bot-presentation'
import { useBotHostLabel } from '../use-bot-host-label'
import { translateLocalExecutionHostLabel } from '@/runtime/hosts/display/execution-host-label'
import { SettingsInsetGroup, SettingsInsetRow } from './BotSettingsRows'

/** This computer's label, as Settings › Bots names its group; the server's name for a paired one. */
export function useBotComputerName(bot: Pick<Bot, 'hostId'>): string {
  const t = useTranslate()
  return (
    useBotHostLabel(bot.hostId) ?? translateLocalExecutionHostLabel(getLocalExecutionHostLabel(), t)
  )
}

export function BotComputerPage({
  bot,
  folderPath
}: {
  bot: Bot
  folderPath: string | null
}): React.JSX.Element {
  const t = useTranslate()
  const host = useBotHostLabel(bot.hostId)
  const name = useBotComputerName(bot)
  const serverAccount = useBotHostOrcaAccount(bot.hostId)
  const serverAccountSettled = useBotHostOrcaAccountSettled(bot.hostId)
  const ownAccount = useAppStore((state) => state.orcaProfileAuthStatus)
  const offline = useBotHostOffline(bot.hostId)
  // Checking… until the sign-in is read; nothing when it can't be (offline, an older server).
  const accountLine = (): string | undefined => {
    if (!(host ? serverAccount : ownAccount)) {
      return offline || (host && serverAccountSettled)
        ? undefined
        : t('bots.settingsView.accountChecking', 'Checking…')
    }
    const email = host
      ? serverAccount?.state === 'signed-in'
        ? serverAccount.email
        : undefined
      : ownAccount?.cloud?.email
    return email ?? t('settings.bots.group.signedOut', 'Signed out of Orca')
  }
  const copyPath = (): void => {
    if (folderPath) {
      void window.api.ui.writeClipboardText(folderPath)
      toast.success(t('bots.settingsView.pathCopied', 'Path copied'))
    }
  }
  return (
    <SettingsInsetGroup
      foot={
        host
          ? t(
              'bots.settingsView.computerOnHostFoot',
              'Its connectors, tools and files live on {{host}}. Settings for all of {{host}}’s bots are in Settings › Bots.',
              { host }
            )
          : t(
              'bots.settingsView.computerFoot',
              'Its connectors, tools and files live on this computer.'
            )
      }
    >
      <SettingsInsetRow
        icon={host ? <Server /> : <Laptop />}
        title={name}
        detail={
          host
            ? t(
                'bots.settingsView.pairedServer',
                'Paired server · runs this bot’s chats, tools and automations'
              )
            : t('bots.settingsView.thisComputerDetail', 'This computer')
        }
      />
      <SettingsInsetRow
        icon={<UserRound />}
        title={t('bots.settingsView.orcaAccount', 'Orca account')}
        detail={accountLine()}
      />
      <SettingsInsetRow
        icon={<Folder />}
        title={t('bots.settingsView.folder', 'Folder')}
        detail={botFolderDisplay(bot.folder)}
        end={
          folderPath ? (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t('bots.settingsView.copyPath', 'Copy path')}
              onClick={copyPath}
            >
              <Copy />
            </Button>
          ) : undefined
        }
      />
    </SettingsInsetGroup>
  )
}
