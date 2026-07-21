import React from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { AgentsPane } from '@/components/settings/AgentsPane'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { useLocalWindowsTerminalCapabilities } from '@/lib/windows-terminal-capabilities'
import { isWebClientLocation } from '@/lib/web-client-location'

type AgentSettingsDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export default function AgentSettingsDialog({
  open,
  onOpenChange
}: AgentSettingsDialogProps): React.JSX.Element | null {
  const settings = useAppStore((s) => s.settings)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const isWindowsRenderer =
    typeof navigator !== 'undefined' && navigator.userAgent.includes('Windows')
  const isWebClient = isWebClientLocation()
  const localWindowsTerminalCapabilities = useLocalWindowsTerminalCapabilities(
    open && (isWindowsRenderer || isWebClient),
    false
  )
  const wslSupportedPlatform =
    isWindowsRenderer || localWindowsTerminalCapabilities.hostPlatform === 'win32'

  if (!settings) {
    return null
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Why: widen past the default sm:max-w-lg so the agent rows have room
          for the name + pills + action cluster without wrapping, while a
          bounded max-h plus overflow-y keeps the list scrollable when many
          agents are detected. */}
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="text-sm">
            {translate('auto.components.agent.AgentSettingsDialog.fc0268e4ed', 'Agents')}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {translate(
              'auto.components.agent.AgentSettingsDialog.50cdb57c03',
              'Manage AI agents, set a default, and customize commands.'
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="scrollbar-sleek -mr-2 max-h-[70vh] overflow-y-auto pr-2">
          <AgentsPane
            settings={settings}
            updateSettings={updateSettings}
            wslSupportedPlatform={wslSupportedPlatform}
            wslAvailable={localWindowsTerminalCapabilities.wslAvailable}
            wslDistros={localWindowsTerminalCapabilities.wslDistros}
            wslCapabilitiesLoading={localWindowsTerminalCapabilities.isLoading}
          />
        </div>
      </DialogContent>
    </Dialog>
  )
}
