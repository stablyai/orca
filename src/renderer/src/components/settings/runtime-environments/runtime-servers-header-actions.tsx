import { ArrowUpRight, ChevronDown, Cloud, Link2, Plus, TerminalSquare } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store/index'
import { LoadingSpinner } from '../../LoadingSpinner'
import { Button } from '../../ui/button'
import { ButtonGroup } from '../../ui/button-group'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '../../ui/dropdown-menu'
import { useRuntimeServersPage } from './runtime-servers-page-context'
import { RuntimeShareComputerButton } from './pairing/runtime-share-computer-button'
import { getManagedOrcadApi } from '../../../runtime/hosts/installation/managed-orcad-api-availability'

function AddServerMenuItem({
  icon,
  label,
  description,
  trailing,
  onSelect
}: {
  icon: React.ReactNode
  label: string
  description: string
  trailing?: React.ReactNode
  onSelect: () => void
}): React.JSX.Element {
  return (
    <DropdownMenuItem className="items-start" onSelect={onSelect}>
      <span className="mt-0.5">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1">
          {label}
          {trailing}
        </span>
        <span className="block text-2xs text-muted-foreground">{description}</span>
      </span>
    </DropdownMenuItem>
  )
}

export function RuntimeServersHeaderActions({
  canGeneratePairingUrl
}: {
  canGeneratePairingUrl: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const { setDialog } = useRuntimeServersPage()
  const remoteServerUpdates = useAppStore((state) => state.remoteServerUpdates)
  const remoteServerUpdatesChecking = useAppStore((state) => state.remoteServerUpdatesChecking)
  const remoteServerUpdatesRunning = useAppStore((state) => state.remoteServerUpdatesRunning)
  const openSettingsTarget = useAppStore((state) => state.openSettingsTarget)
  const setRemoteServerUpdateDialogOpen = useAppStore(
    (state) => state.setRemoteServerUpdateDialogOpen
  )
  const canInstall = getManagedOrcadApi() !== undefined
  let availableCount = 0
  for (const entry of remoteServerUpdates.values()) {
    if (entry.phase === 'available') {
      availableCount += 1
    }
  }

  return (
    <div data-settings-section="remote-server-updates" className="flex items-center gap-2">
      {/* One update already takes one click on its own row. */}
      {remoteServerUpdatesRunning || availableCount >= 2 ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={remoteServerUpdatesChecking && remoteServerUpdates.size === 0}
          onClick={() => setRemoteServerUpdateDialogOpen(true)}
        >
          {remoteServerUpdatesRunning ? <LoadingSpinner className="size-3.5" /> : null}
          {remoteServerUpdatesRunning
            ? t(
                'auto.components.settings.RuntimeEnvironmentsPane.updatingServers',
                'Updating servers…'
              )
            : t('auto.components.settings.serverList.updateAll', 'Update all ({{count}})', {
                count: availableCount
              })}
        </Button>
      ) : null}
      <ButtonGroup>
        <Button type="button" variant="outline" size="sm" onClick={() => setDialog('add')}>
          <Plus />
          {t('auto.components.settings.serverList.addServer', 'Add server')}
        </Button>
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              aria-label={t(
                'auto.components.settings.serverList.moreWaysToAdd',
                'More ways to add a server'
              )}
            >
              <ChevronDown />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-80">
            <AddServerMenuItem
              icon={<Link2 />}
              label={t('auto.components.settings.serverList.pasteAccessLink', 'Paste access link')}
              description={t(
                'auto.components.settings.serverList.pasteAccessLinkHelp',
                'Pair with Orca already running on another machine.'
              )}
              onSelect={() => setDialog('add')}
            />
            {canInstall ? (
              <AddServerMenuItem
                icon={<TerminalSquare />}
                label={t(
                  'auto.components.settings.serverList.setUpOnSshHost',
                  'Set up Orca on an SSH host'
                )}
                description={t(
                  'auto.components.settings.managedServers.description',
                  'Orca installs itself on an empty SSH host and keeps itself up to date.'
                )}
                onSelect={() => setDialog('install')}
              />
            ) : null}
            <AddServerMenuItem
              icon={<Cloud />}
              label={t('auto.components.settings.serverList.cloudVm', 'Cloud VM')}
              trailing={<ArrowUpRight className="ml-auto" />}
              description={t(
                'auto.components.settings.serverList.cloudVmHelp',
                'Created per workspace from an environment recipe.'
              )}
              onSelect={() =>
                openSettingsTarget({
                  pane: 'experimental',
                  repoId: null,
                  sectionId: 'ephemeral-vms'
                })
              }
            />
          </DropdownMenuContent>
        </DropdownMenu>
      </ButtonGroup>
      {canGeneratePairingUrl ? <RuntimeShareComputerButton /> : null}
    </div>
  )
}
