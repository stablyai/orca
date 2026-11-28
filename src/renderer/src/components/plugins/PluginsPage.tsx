import { useAppStore } from '@/store/index'
import { PluginsSettingsSection } from './list/PluginsSettingsSection'

/** The app rail's Plugins page: Settings > Plugins' content in the rail-page frame. */
export default function PluginsPage(): React.JSX.Element | null {
  const settings = useAppStore((s) => s.settings)
  const updateSettingsOrThrow = useAppStore((s) => s.updateSettingsOrThrow)
  const closePluginsPage = useAppStore((s) => s.closePluginsPage)
  if (!settings) {
    return null
  }
  return (
    <PluginsSettingsSection
      mounted
      settings={settings}
      updateSettings={updateSettingsOrThrow}
      railPage={{ onClose: closePluginsPage }}
    />
  )
}
