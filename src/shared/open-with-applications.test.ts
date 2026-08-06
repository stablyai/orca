import { describe, expect, it } from 'vitest'
import {
  addOpenWithApplication,
  buildOpenWithCommand,
  deriveOpenWithLabel,
  getOpenWithFileTypeKey,
  normalizeOpenWithSettings,
  removeOpenWithApplication,
  resolveOpenWithDefaultApplication,
  setOpenWithDefault
} from './open-with-applications'
import type { OpenWithApplication } from './types'

const preview: OpenWithApplication = {
  id: 'app-preview',
  label: 'Preview',
  command: `open -a '/Applications/Preview.app'`,
  applicationPath: '/Applications/Preview.app'
}

describe('buildOpenWithCommand', () => {
  it('wraps macOS bundles in open -a because a .app is not executable', () => {
    expect(buildOpenWithCommand('/Applications/Preview.app', 'darwin')).toBe(
      `open -a '/Applications/Preview.app'`
    )
    expect(buildOpenWithCommand('/Applications/Sublime Text.app/', 'darwin')).toBe(
      `open -a '/Applications/Sublime Text.app'`
    )
  })

  it('quotes a spaced executable so the launcher keeps it a direct path', () => {
    expect(buildOpenWithCommand('C:\\Program Files\\App\\app.exe', 'win32')).toBe(
      '"C:\\Program Files\\App\\app.exe"'
    )
    expect(buildOpenWithCommand('/opt/my app/bin/edit', 'linux')).toBe(`'/opt/my app/bin/edit'`)
  })

  it('launches Linux desktop entries through gio and leaves bare binaries alone', () => {
    expect(buildOpenWithCommand('/usr/share/applications/gimp.desktop', 'linux')).toBe(
      `gio launch '/usr/share/applications/gimp.desktop'`
    )
    expect(buildOpenWithCommand('/usr/bin/gimp', 'linux')).toBe('/usr/bin/gimp')
  })

  it('rejects an empty pick', () => {
    expect(buildOpenWithCommand('   ', 'darwin')).toBeNull()
  })
})

describe('deriveOpenWithLabel', () => {
  it('strips the platform app suffix', () => {
    expect(deriveOpenWithLabel('/Applications/Preview.app')).toBe('Preview')
    expect(deriveOpenWithLabel('C:\\Apps\\sublime_text.exe')).toBe('sublime_text')
    expect(deriveOpenWithLabel('/usr/bin/gimp')).toBe('gimp')
  })
})

describe('getOpenWithFileTypeKey', () => {
  it('lowercases the extension and ignores dotfiles', () => {
    expect(getOpenWithFileTypeKey('/repo/Photo.PNG')).toBe('.png')
    expect(getOpenWithFileTypeKey('/repo/src/index.test.ts')).toBe('.ts')
    expect(getOpenWithFileTypeKey('/repo/.gitignore')).toBeNull()
    expect(getOpenWithFileTypeKey('/repo/Makefile')).toBeNull()
    expect(getOpenWithFileTypeKey('/repo/trailing.')).toBeNull()
  })
})

describe('addOpenWithApplication', () => {
  it('reuses the stored id when the same bundle is picked again', () => {
    const repicked = { ...preview, id: 'app-fresh-uuid', label: 'Preview 2' }
    const next = addOpenWithApplication([preview], repicked)

    expect(next).toHaveLength(1)
    expect(next[0]).toMatchObject({ id: 'app-preview', label: 'Preview 2' })
  })

  it('appends a distinct bundle', () => {
    const typora: OpenWithApplication = {
      id: 'app-typora',
      label: 'Typora',
      command: `open -a '/Applications/Typora.app'`,
      applicationPath: '/Applications/Typora.app'
    }
    expect(addOpenWithApplication([preview], typora).map((entry) => entry.id)).toEqual([
      'app-preview',
      'app-typora'
    ])
  })
})

describe('normalizeOpenWithSettings', () => {
  it('drops rules whose app no longer exists', () => {
    const result = normalizeOpenWithSettings([preview], {
      '.png': 'app-preview',
      '.md': 'app-deleted'
    })

    expect(result.openWithDefaults).toEqual({ '.png': 'app-preview' })
  })

  it('rejects malformed rows and keys', () => {
    const result = normalizeOpenWithSettings(
      [preview, { id: 'broken', label: 'No command' }, 'nope'],
      { png: 'app-preview', '.': 'app-preview', '.PNG': 'app-preview' }
    )

    expect(result.openWithApplications).toHaveLength(1)
    expect(result.openWithDefaults).toEqual({ '.png': 'app-preview' })
  })

  it('returns empty state for non-array/non-object input', () => {
    expect(normalizeOpenWithSettings(null, null)).toEqual({
      openWithApplications: [],
      openWithDefaults: {}
    })
  })
})

describe('resolveOpenWithDefaultApplication', () => {
  it('returns the pinned app for the extension', () => {
    expect(
      resolveOpenWithDefaultApplication('/repo/a.png', [preview], { '.png': 'app-preview' })
    ).toBe(preview)
  })

  it('falls through when the type has no rule', () => {
    expect(
      resolveOpenWithDefaultApplication('/repo/a.ts', [preview], { '.png': 'app-preview' })
    ).toBeNull()
    expect(resolveOpenWithDefaultApplication('/repo/a.png', [preview], undefined)).toBeNull()
  })
})

describe('setOpenWithDefault', () => {
  it('sets and clears a rule without touching the others', () => {
    const set = setOpenWithDefault({ '.md': 'app-typora' }, '.png', 'app-preview')
    expect(set).toEqual({ '.md': 'app-typora', '.png': 'app-preview' })
    expect(setOpenWithDefault(set, '.png', null)).toEqual({ '.md': 'app-typora' })
  })
})

describe('removeOpenWithApplication', () => {
  it('removes by id', () => {
    expect(removeOpenWithApplication([preview], 'app-preview')).toEqual([])
    expect(removeOpenWithApplication([preview], 'other')).toEqual([preview])
  })
})

describe('adopted Open in editors', () => {
  const vscode: OpenWithApplication = {
    id: 'vscode',
    label: 'VS Code',
    command: 'code',
    applicationPath: ''
  }

  it('survives normalization without a bundle path so its rule can resolve', () => {
    const result = normalizeOpenWithSettings([vscode], { '.ts': 'vscode' })

    expect(result.openWithApplications).toEqual([vscode])
    expect(result.openWithDefaults).toEqual({ '.ts': 'vscode' })
    expect(resolveOpenWithDefaultApplication('/repo/a.ts', [vscode], { '.ts': 'vscode' })).toBe(
      vscode
    )
  })

  it('dedupes on command when there is no bundle path to compare', () => {
    const next = addOpenWithApplication([vscode], { ...vscode, id: 'fresh', label: 'VS Code 2' })

    expect(next).toHaveLength(1)
    expect(next[0]).toMatchObject({ id: 'vscode', label: 'VS Code 2' })
  })

  it('still rejects a row with no command at all', () => {
    expect(
      normalizeOpenWithSettings([{ id: 'broken', label: 'No command', applicationPath: '/x' }], {})
        .openWithApplications
    ).toEqual([])
  })
})
