import {
  parseVscodeIconTheme,
  type SvgIconRegistry,
  type VscodeIconThemeShape
} from './vscode-icon-theme'

/**
 * Load the bundled material-icons.json as a raw string via glob — direct
 * `?raw` imports on this path were rejected by Vite's import-analysis. The
 * glob lookup keeps the build static (eager: true) while bypassing whatever
 * rule blocks the bare import.
 */
const JSON_FILES = import.meta.glob<string>(
  '../../../assets/icon-themes/material/material-icons.json',
  { query: '?raw', import: 'default', eager: true }
)
const materialJsonRaw = Object.values(JSON_FILES)[0]
if (!materialJsonRaw) {
  throw new Error('Material Icon Theme JSON asset missing — verify build output.')
}
const materialJson: unknown = JSON.parse(materialJsonRaw)
import type { IconTheme } from './types'

/**
 * Vite collects every Material SVG as a URL at build time. `eager: true` here
 * does NOT inline the SVGs into the JS bundle — Vite emits each `.svg` as a
 * separate file under `out/web/assets/...` and the value of the record is the
 * hashed asset URL. That keeps the JS bundle untouched while letting us look
 * up icons synchronously from a registry.
 */
const ICON_URLS = import.meta.glob<string>('../../../assets/icon-themes/material/icons/*.svg', {
  query: '?url',
  import: 'default',
  eager: true
})

/**
 * Index `ICON_URLS` by bare filename so we can resolve definition paths like
 * `./../icons/git.svg` regardless of the glob's resolved key prefix.
 */
const URL_BY_FILENAME: Record<string, string> = (() => {
  const out: Record<string, string> = {}
  for (const [key, url] of Object.entries(ICON_URLS)) {
    const filename = key.split('/').pop()
    if (filename) {
      out[filename] = url
    }
  }
  return out
})()

const registry: SvgIconRegistry = {
  resolveIconUrl: (iconPath) => {
    const filename = iconPath.split('/').pop()
    if (!filename) {
      return null
    }
    return URL_BY_FILENAME[filename] ?? null
  }
}

const SHAPE = materialJson as VscodeIconThemeShape

export const materialIconTheme: IconTheme =
  parseVscodeIconTheme(SHAPE, registry, {
    id: 'material',
    name: 'Material Icon Theme',
    description:
      'The official Material Icon Theme port (philippkief / material-extensions, MIT). 1245 icons covering languages, configs, and folders.',
    variant: 'default'
  }) ??
  (() => {
    throw new Error(
      'Material Icon Theme failed to parse — the bundled material-icons.json is missing required defaults.'
    )
  })()

/**
 * Optional light-mode counterpart. Material's JSON ships a `light` block that
 * swaps a handful of icons (yaml, prettier, etc.) for higher-contrast
 * versions on light backgrounds. Returned as a separate theme so users can
 * pair `material` with `material-light` via the dark/light pickers.
 */
export const materialLightIconTheme: IconTheme | null = parseVscodeIconTheme(SHAPE, registry, {
  id: 'material-light',
  name: 'Material Icon Theme (Light)',
  description: 'Light-mode variant of the Material Icon Theme.',
  variant: 'light'
})
