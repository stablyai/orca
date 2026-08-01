import { useMemo } from 'react'
import { ShieldCheck } from 'lucide-react'
import { Button } from '../ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger
} from '../ui/dropdown-menu'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { resolveTerminalTabTitle } from '../../../../shared/tab-title-resolution'
import type { TerminalTab } from '../../../../shared/types'

export type HostTerminalOption = {
  handle: string
  title: string | null
  tabId: string
}

type PeerTerminalGrantMenuProps = {
  deviceName: string
  grantedTerminals: readonly string[]
  hostTerminals: readonly HostTerminalOption[]
  onSetGrantedTerminals: (handles: string[]) => void
}

/**
 * Grant picker shared by the connected-clients list and the paired-devices
 * list — grants key off deviceId in the device registry, so the host can
 * manage them whether or not the device is connected right now.
 */
export function PeerTerminalGrantMenu({
  deviceName,
  grantedTerminals,
  hostTerminals,
  onSetGrantedTerminals
}: PeerTerminalGrantMenuProps): React.JSX.Element {
  const tabsByWorktree = useAppStore((s) => s.tabsByWorktree)
  const generatedTitlesEnabled = useAppStore((s) => s.settings?.tabAutoGenerateTitle === true)

  // Why: the IPC payload only carries the terminal's raw/live title (see
  // peerCollab:listHostTerminals); the tab's actual display name (custom
  // rename, quick-command label, generated title) lives in this store.
  const terminalTabById = useMemo(() => {
    const map = new Map<string, TerminalTab>()
    for (const tabs of Object.values(tabsByWorktree)) {
      for (const tab of tabs) {
        map.set(tab.id, tab)
      }
    }
    return map
  }, [tabsByWorktree])

  function resolveHostTerminalTitle(terminal: HostTerminalOption): string {
    const tab = terminalTabById.get(terminal.tabId)
    const fallback =
      terminal.title ||
      translate(
        'auto.components.settings.PeerCollabSettingsPane.untitledTerminal',
        'Untitled terminal'
      )
    return tab ? resolveTerminalTabTitle(tab, generatedTitlesEnabled, fallback) : fallback
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          title={translate(
            'auto.components.settings.PeerCollabSettingsPane.grantTerminals',
            'Share terminals'
          )}
        >
          <ShieldCheck className="size-3.5" />
          {grantedTerminals.length > 0 ? ` ${grantedTerminals.length}` : ''}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>
          {translate(
            'auto.components.settings.PeerCollabSettingsPane.grantTerminalsLabel',
            'Terminals shared with {{name}}',
            { name: deviceName }
          )}
        </DropdownMenuLabel>
        {hostTerminals.length === 0 ? (
          <p className="text-muted-foreground px-2 py-1.5 text-xs">
            {translate(
              'auto.components.settings.PeerCollabSettingsPane.noHostTerminalsToGrant',
              'No terminals available to share.'
            )}
          </p>
        ) : (
          hostTerminals.map((terminal) => {
            const granted = grantedTerminals.includes(terminal.handle)
            return (
              <DropdownMenuCheckboxItem
                key={terminal.handle}
                checked={granted}
                onCheckedChange={(checked) =>
                  onSetGrantedTerminals(
                    checked
                      ? [...grantedTerminals, terminal.handle]
                      : grantedTerminals.filter((h) => h !== terminal.handle)
                  )
                }
              >
                {resolveHostTerminalTitle(terminal)}
              </DropdownMenuCheckboxItem>
            )
          })
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
