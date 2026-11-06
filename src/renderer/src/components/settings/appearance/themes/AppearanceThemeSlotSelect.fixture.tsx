import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { getDefaultSettings } from '../../../../../../shared/constants'
import { usePluginThemeStore } from '@/store/plugin-themes'
import { AppearanceThemeSlotSelect } from './AppearanceThemeControl'

const live = {
  id: 'plugin:wilkywayre.orcarchy/runtime-dark',
  pluginKey: 'wilkywayre.orcarchy',
  pluginName: 'Orcarchy',
  label: 'Orcarchy (dark)',
  base: 'dark',
  revision: 'fixture',
  tokens: { '--background': '#1a1b26', '--foreground': '#a9b1d6', '--primary': '#7aa2f7' }
} as const

const packaged = {
  ...live,
  id: 'plugin:acme.themes/nord',
  pluginKey: 'acme.themes',
  pluginName: 'Acme Themes',
  label: 'Nord',
  tokens: { '--background': '#2e3440', '--foreground': '#d8dee9', '--primary': '#88c0d0' }
} as const

function Slot(): React.JSX.Element {
  usePluginThemeStore.setState({ entries: [live, packaged], loaded: true })
  const settings = {
    ...getDefaultSettings('/fixture'),
    pluginAppThemeDark: live.id
  }
  return (
    <AppearanceThemeSlotSelect
      base="dark"
      label="Dark theme"
      settings={settings}
      updateSettings={() => {}}
    />
  )
}

/** A plugin's live colors sit beside Match Terminal as a dynamic choice. */
export const dynamicPluginTheme = defineFixture({
  width: 360,
  render: () => (
    <div className="h-[340px]">
      <Slot />
    </div>
  ),
  interact: (frame) => {
    frame.querySelector<HTMLButtonElement>('button[aria-label="Dark theme"], button')?.click()
  }
})
