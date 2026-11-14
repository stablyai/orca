import {
  COMMON_FILES,
  json,
  manifest,
  pluginIdFromName,
  readme
} from '../plugins/authoring/plugin-template-files'
import { hasUsableTerminalThemeColors } from '../terminal-themes/terminal-custom-themes'
import {
  THEME_STUDIO_MODES,
  type ThemeStudioDraft,
  type ThemeStudioMode
} from './theme-studio-draft'

const FALLBACK_ID = 'my-theme'
// Why: ids starting `orca-` install only from Orca's official catalog.
const RESERVED_ID_PREFIX = 'orca-'

/** A kebab-case plugin id for a theme name that installs from a local folder. */
export function themeStudioPluginId(name: string): string {
  const id = pluginIdFromName(name).slice(0, 48).replace(/-+$/, '') || FALLBACK_ID
  return id.startsWith(RESERVED_ID_PREFIX) ? `my-${id}` : id
}

/** The files of a content-only theme plugin holding the draft: app themes for each mode the
 *  draft has, and terminal palettes where one is complete. Paths always use `/`. */
export function themeStudioPluginFiles(
  draft: ThemeStudioDraft,
  id = themeStudioPluginId(draft.name)
): { id: string; files: Record<string, string> } {
  const modes = THEME_STUDIO_MODES.filter((mode) => draft[mode] !== null)
  const terminalModes = modes.filter((mode) => {
    const terminal = draft[mode]?.terminal
    return terminal !== undefined && hasUsableTerminalThemeColors(terminal)
  })
  const label = (mode: ThemeStudioMode): string =>
    modes.length > 1 ? `${draft.name} ${mode === 'dark' ? 'Dark' : 'Light'}` : draft.name
  const input = { id, name: draft.name }
  const files: Record<string, string> = {
    'orca-plugin.json': manifest(
      input,
      modes.length > 1 ? 'A light and dark app theme.' : `A ${modes[0] ?? 'dark'} app theme.`,
      {
        execution: 'data',
        contributes: {
          themes: modes.map((mode) => ({
            id: `${id}-${mode}`,
            title: label(mode),
            path: `themes/${mode}.json`
          })),
          ...(terminalModes.length
            ? {
                terminalThemes: terminalModes.map((mode) => ({
                  id: `${id}-terminal-${mode}`,
                  title: label(mode),
                  path: `terminal/${mode}.json`
                }))
              }
            : {})
        }
      }
    ),
    'README.md': readme(
      input,
      'An Orca app theme made with `orca theme`. Each mode lives in `themes/<mode>.json`; terminal palettes in `terminal/<mode>.json`.'
    ),
    ...COMMON_FILES
  }
  for (const mode of modes) {
    const variant = draft[mode]
    if (!variant) {
      continue
    }
    files[`themes/${mode}.json`] = json({
      schemaVersion: 1,
      base: mode,
      tokens: variant.tokens,
      ...(variant.tokenColors?.length ? { tokenColors: variant.tokenColors } : {})
    })
    if (terminalModes.includes(mode)) {
      files[`terminal/${mode}.json`] = json({ schemaVersion: 1, mode, terminal: variant.terminal })
    }
  }
  return { id, files }
}
