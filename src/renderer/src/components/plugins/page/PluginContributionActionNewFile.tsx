import type { ActivePluginNewFile } from '@/store/plugin-new-files'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { Button } from '../../ui/button'
import { pluginPanelUnavailableReason } from './plugin-contribution-action-availability'

/** Leaves Settings for the workspace it came from and creates the file there, as the + menu does. */
export function openPluginNewFileFromSettings(newFile: ActivePluginNewFile): void {
  const state = useAppStore.getState()
  // Why the panel rule: both need Settings to close onto an open workspace.
  if (pluginPanelUnavailableReason(state)) {
    return
  }
  state.closeSettingsPage()
  void state.openNewPluginFileInActiveWorkspace(newFile)
}

export function PluginContributionActionNewFile({
  newFile
}: {
  newFile: ActivePluginNewFile
}): React.JSX.Element {
  const unavailableReason = useAppStore((state) => pluginPanelUnavailableReason(state))
  return (
    <span className="flex items-center gap-2">
      {unavailableReason ? (
        <span className="text-xs text-muted-foreground">{unavailableReason}</span>
      ) : null}
      <Button
        variant="outline"
        size="xs"
        disabled={unavailableReason !== null}
        aria-label={newFile.title}
        onClick={() => openPluginNewFileFromSettings(newFile)}
      >
        {translate('auto.components.settings.PluginContributionActionNewFile.create', 'Create')}
      </Button>
    </span>
  )
}
