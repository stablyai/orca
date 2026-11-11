import type { GlobalSettings } from './global-settings-types'
import { DEFAULT_APP_FONT_FAMILY } from './constants'
import { isPluginFontFamilyOf } from './plugins/contributions/plugin-font-contribution'
import { defaultTerminalFontFamily } from './terminal/appearance/terminal-platform-defaults'

/** Font choices that named a removed plugin's family go back to their defaults. */
export function pluginFontSettingsAfterRemoval(
  settings: Pick<
    GlobalSettings,
    'appFontFamily' | 'terminalFontFamily' | 'editorFontFamily' | 'nativeChatAppearance'
  >,
  pluginKey: string
): Partial<GlobalSettings> {
  const update: Partial<GlobalSettings> = {}
  if (isPluginFontFamilyOf(settings.appFontFamily, pluginKey)) {
    update.appFontFamily = DEFAULT_APP_FONT_FAMILY
  }
  if (isPluginFontFamilyOf(settings.terminalFontFamily, pluginKey)) {
    update.terminalFontFamily = defaultTerminalFontFamily()
  }
  if (isPluginFontFamilyOf(settings.editorFontFamily, pluginKey)) {
    update.editorFontFamily = ''
  }
  const chat = settings.nativeChatAppearance
  if (chat && isPluginFontFamilyOf(chat.fontFamily, pluginKey)) {
    const { fontFamily: _removed, ...rest } = chat
    update.nativeChatAppearance = rest
  }
  return update
}
