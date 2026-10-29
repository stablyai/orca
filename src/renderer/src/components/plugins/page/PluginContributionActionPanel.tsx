import type { PluginHostPanel } from '../../../../../preload/api-types'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { Button } from '../../ui/button'
import { pluginPanelUnavailableReason } from './plugin-contribution-action-availability'

/** Leaves Settings for the workspace it came from and reveals the panel there. */
export function PluginContributionActionPanel({
  panel
}: {
  panel: PluginHostPanel
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
        aria-label={translate(
          'auto.components.settings.PluginContributionActionPanel.openName',
          'Open panel: {{value0}}',
          { value0: panel.title }
        )}
        onClick={() => {
          const state = useAppStore.getState()
          // Why re-check: the store may have moved on since this rendered.
          if (pluginPanelUnavailableReason(state)) {
            return
          }
          state.closeSettingsPage()
          state.setRightSidebarTab(panel.tabKey)
          state.setRightSidebarOpen(true)
        }}
      >
        {translate('auto.components.settings.PluginContributionActionPanel.open', 'Open panel')}
      </Button>
    </span>
  )
}
