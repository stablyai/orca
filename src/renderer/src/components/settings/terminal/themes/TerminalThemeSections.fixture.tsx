import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { useAppStore } from '../../../../store'
import { TERMINAL_THEME_CATALOG } from '../../../../../../shared/terminal-themes/terminal-theme-catalog'
import { Toaster } from '../../../ui/sonner'
import { TerminalThemeCatalogSection } from './TerminalThemeSections'
import { useWarpThemeImport } from './useWarpThemeImport'
import { WarpThemeImportModal } from './WarpThemeImportModal'

function TerminalThemesFixture(): React.JSX.Element {
  const settings = useAppStore((state) => state.settings)
  const updateSettings = useAppStore((state) => state.updateSettings)
  const warpThemes = useWarpThemeImport(updateSettings, settings)
  if (!settings) {
    throw new Error('The theme fixture requires settings.')
  }
  return (
    <>
      <TerminalThemeCatalogSection
        settings={settings}
        systemPrefersDark={settings.theme !== 'light'}
        updateSettings={updateSettings}
        previewFontFamily={null}
        importedHighlightSignal={warpThemes.importSignal}
        warpThemes={warpThemes}
        showThemeImport
        preferredTarget="dark"
      />
      <WarpThemeImportModal {...warpThemes} />
      <Toaster />
    </>
  )
}

function setup(): void {
  useAppStore.setState({
    updateSettings: async (updates) => {
      const settings = useAppStore.getState().settings
      if (!settings) {
        throw new Error('The theme fixture requires settings.')
      }
      useAppStore.setState({ settings: { ...settings, ...updates } })
    }
  })
}

export const defaults = defineFixture({
  width: 840,
  setup,
  render: () => <TerminalThemesFixture />
})

export const pickerOpen = defineFixture({
  ...defaults,
  interact: (frame) => {
    frame.querySelector<HTMLButtonElement>('button[role="combobox"]')?.click()
  }
})

export const importable = defineFixture({
  ...defaults,
  setup: () => {
    setup()
    window.api.settings.previewWarpThemeImport = async () => ({
      found: true,
      themes: [
        {
          id: 'warp:fixture-nord',
          selectionValue: 'custom:warp:fixture-nord',
          name: 'Nord (Warp)',
          source: 'warp',
          mode: 'dark',
          terminal: TERMINAL_THEME_CATALOG.Nord,
          importedAt: '2026-01-01T00:00:00.000Z'
        }
      ],
      skippedFiles: []
    })
  }
})
