import { describe, expect, it } from 'vitest'
import type { PluginIconThemeRegistration } from './plugin-icon-theme-artifact'
import {
  resolvePluginFileIconUrl,
  selectActivePluginIconTheme
} from './plugin-file-icon-resolution'

const THEME: PluginIconThemeRegistration = {
  id: 'samples.demo-file-icons#demo',
  pluginKey: 'samples.demo-file-icons',
  themeId: 'demo',
  label: 'Demo Icons',
  icons: {
    ts: 'data:image/svg+xml;base64,dHM=',
    dts: 'data:image/svg+xml;base64,ZHRz',
    npm: 'data:image/svg+xml;base64,bnBt',
    fallback: 'data:image/svg+xml;base64,ZmFsbGJhY2s='
  },
  fileExtensions: { ts: 'ts', 'd.ts': 'dts' },
  fileNames: { 'package.json': 'npm' },
  defaultIcon: 'fallback'
}

describe('resolvePluginFileIconUrl', () => {
  it('prefers an exact filename match over an extension match', () => {
    expect(resolvePluginFileIconUrl(THEME, 'app/package.json')).toBe(THEME.icons.npm)
  })

  it('prefers the longest matching compound extension', () => {
    expect(resolvePluginFileIconUrl(THEME, 'src/types.d.ts')).toBe(THEME.icons.dts)
    expect(resolvePluginFileIconUrl(THEME, 'src/index.ts')).toBe(THEME.icons.ts)
  })

  it('matches case-insensitively', () => {
    expect(resolvePluginFileIconUrl(THEME, 'SRC/Index.TS')).toBe(THEME.icons.ts)
  })

  it('splits Windows and POSIX paths alike', () => {
    expect(resolvePluginFileIconUrl(THEME, 'C:\\repo\\src\\index.ts')).toBe(THEME.icons.ts)
  })

  it('falls back to the theme default for unclaimed files', () => {
    expect(resolvePluginFileIconUrl(THEME, 'notes.unknown')).toBe(THEME.icons.fallback)
  })

  it('returns null without a theme so callers use built-in icons', () => {
    expect(resolvePluginFileIconUrl(null, 'src/index.ts')).toBeNull()
  })

  it('returns null for an empty path', () => {
    expect(resolvePluginFileIconUrl(THEME, '')).toBeNull()
    expect(resolvePluginFileIconUrl(THEME, null)).toBeNull()
  })

  it('returns null when a lookup names a definition with no loaded icon', () => {
    const broken = { ...THEME, fileExtensions: { ts: 'missing' }, defaultIcon: null }
    expect(resolvePluginFileIconUrl(broken, 'index.ts')).toBeNull()
  })

  // The registry copy and the IPC structured clone both restore Object.prototype,
  // so a bare `table[name]` would resolve these to inherited members.
  it.each(['constructor', '__proto__', 'tostring', 'valueof'])(
    'does not resolve %s through Object.prototype',
    (filename) => {
      expect(resolvePluginFileIconUrl(THEME, filename)).toBe(THEME.icons.fallback)
    }
  )

  it('still falls back to built-in icons for a prototype-named file with no theme default', () => {
    expect(resolvePluginFileIconUrl({ ...THEME, defaultIcon: null }, 'constructor')).toBeNull()
  })

  it('matches a compound extension deeper than three segments', () => {
    const deep = {
      ...THEME,
      fileExtensions: { ...THEME.fileExtensions, 'generated.api.client.ts': 'npm' }
    }
    expect(resolvePluginFileIconUrl(deep, 'schema.generated.api.client.ts')).toBe(deep.icons.npm)
  })
})

describe('selectActivePluginIconTheme', () => {
  it('activates a lone contributed theme', () => {
    expect(selectActivePluginIconTheme([THEME])).toBe(THEME)
  })

  it('stays on built-in icons when no theme is contributed', () => {
    expect(selectActivePluginIconTheme([])).toBeNull()
  })

  it('requires an explicit choice when several themes compete', () => {
    const other = { ...THEME, id: 'other#demo' }
    expect(selectActivePluginIconTheme([THEME, other])).toBeNull()
    expect(selectActivePluginIconTheme([THEME, other], 'other#demo')).toBe(other)
  })

  it('falls back to built-in icons when the chosen theme is gone', () => {
    expect(selectActivePluginIconTheme([THEME], 'uninstalled#demo')).toBeNull()
  })
})
