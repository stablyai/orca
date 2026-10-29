import { describe, expect, it } from 'vitest'
import { pluginVerifiedSourceLabel } from './PluginChips'

describe('pluginVerifiedSourceLabel', () => {
  it.each([
    [{ kind: 'official' } as const, null],
    [{ kind: 'bundled' } as const, null],
    [{ kind: 'dev' } as const, 'Dev · unverified'],
    [{ kind: 'unverified' } as const, 'Unverified'],
    [
      { kind: 'catalog', catalog: 'Acme Plugins', owner: 'github.com/acme' } as const,
      'Acme Plugins · github.com/acme'
    ],
    [
      { kind: 'catalog', catalog: null, owner: 'gitlab.com/acme/tools' } as const,
      'gitlab.com/acme/tools'
    ],
    [{ kind: 'catalog', catalog: null, owner: null } as const, 'Unverified']
  ])('labels %o as %s', (source, label) => {
    expect(pluginVerifiedSourceLabel(source)).toBe(label)
  })
})
