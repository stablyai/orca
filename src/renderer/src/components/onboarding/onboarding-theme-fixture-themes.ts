import {
  usePluginTerminalThemeStore,
  usePluginThemeStore
} from '@/store/plugins/appearance/plugin-themes'
import type { PluginThemeRegistration } from '../../../../shared/plugins/artifacts/plugin-theme-artifact'
import type { PluginTerminalThemeRegistration } from '../../../../shared/plugins/artifacts/plugin-terminal-theme-artifact'

// Why real artifacts: the gallery should be judged against the themes Orca actually bundles.
const appThemeFiles = import.meta.glob<{ base: 'dark' | 'light'; tokens: Record<string, string> }>(
  '../../../../../resources/plugins/launch/stablyai.orca-{github-vscode-theme,vscode-default-themes}/themes/*.json',
  { eager: true, import: 'default' }
)
const terminalThemeFiles = import.meta.glob<PluginTerminalThemeRegistration['terminal']>(
  '../../../../../resources/plugins/launch/stablyai.orca-github-vscode-theme/terminal/*.json',
  { eager: true, import: 'terminal' }
)

const fileId = (path: string): string =>
  path
    .split('/')
    .pop()!
    .replace(/\.json$/, '')
const pluginKey = (path: string): string => path.match(/launch\/([^/]+)\//)![1]
const manifests = import.meta.glob<{ contributes: { themes: { id: string; title: string }[] } }>(
  '../../../../../resources/plugins/launch/stablyai.orca-{github-vscode-theme,vscode-default-themes}/orca-plugin.json',
  { eager: true, import: 'default' }
)
const titles = new Map(
  Object.values(manifests).flatMap((manifest) =>
    manifest.contributes.themes.map((theme) => [theme.id, theme.title] as const)
  )
)
const titleCase = (id: string): string => titles.get(id) ?? id

const appThemes: PluginThemeRegistration[] = Object.entries(appThemeFiles).map(([path, file]) => ({
  id: `plugin:${pluginKey(path)}/${fileId(path)}`,
  base: file.base,
  tokens: file.tokens,
  revision: '1',
  pluginKey: pluginKey(path),
  pluginName: pluginKey(path).includes('github') ? 'GitHub Themes' : 'VS Code Themes',
  label: titleCase(fileId(path))
}))
const terminalThemes: PluginTerminalThemeRegistration[] = Object.entries(terminalThemeFiles).map(
  ([path, terminal]) => ({
    id: `plugin:${pluginKey(path)}/${fileId(path)}`,
    pluginKey: pluginKey(path),
    pluginName: 'GitHub Themes',
    label: titleCase(fileId(path)),
    mode: fileId(path).includes('light') ? 'light' : 'dark',
    terminal
  })
)

export function seedPluginThemes(): void {
  usePluginThemeStore.setState({ entries: appThemes, loaded: true })
  usePluginTerminalThemeStore.setState({ entries: terminalThemes, loaded: true })
}
