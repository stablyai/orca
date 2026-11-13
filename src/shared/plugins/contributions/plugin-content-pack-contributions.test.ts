import { describe, expect, it } from 'vitest'
import { pluginManifestSchema } from '../manifest/plugin-manifest'

function manifest(contributes: Record<string, unknown>): Record<string, unknown> {
  return {
    manifestVersion: 1,
    id: 'content-pack',
    publisher: 'samples',
    name: 'Content pack',
    version: '1.0.0',
    engines: { orca: '>=1.0.0' },
    pluginApi: 1,
    contributes,
    capabilities: []
  }
}

describe('content-pack manifest contributions', () => {
  it('rejects duplicate ids, locales, paths, and bindings', () => {
    const parsed = pluginManifestSchema.safeParse(
      manifest({
        languagePacks: [
          { locale: 'pt-BR', path: 'pt-br.json' },
          { locale: 'pt-br', path: 'other.json' }
        ],
        commands: [{ id: 'open', title: 'Open', action: 'view.tasks' }],
        keybindings: [
          { command: 'open', key: 'Mod+T' },
          { command: 'open', key: 'mod+t' }
        ]
      })
    )

    expect(parsed.success).toBe(false)
    if (!parsed.success) {
      expect(parsed.error.issues.map((issue) => issue.message)).toEqual(
        expect.arrayContaining([
          'duplicate language pack locale: pt-br',
          'duplicate keybinding: mod+t'
        ])
      )
    }
  })
})
