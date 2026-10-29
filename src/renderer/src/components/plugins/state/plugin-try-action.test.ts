import { describe, expect, it, vi } from 'vitest'
import { pluginManifestSchema } from '../../../../../shared/plugins/manifest/plugin-manifest'
import { pluginSyntaxSample, pluginTryAction } from './plugin-try-action'

vi.mock('@/store', () => ({ useAppStore: { getState: vi.fn() } }))

const manifest = (contributes: Record<string, unknown>) =>
  pluginManifestSchema.parse({
    manifestVersion: 1,
    id: 'p',
    publisher: 'acme',
    name: 'P',
    version: '1.0.0',
    engines: { orca: '>=1.0.0' },
    pluginApi: 1,
    contributes
  })

const syntax = (extensions: string[]) => ({
  id: 's',
  title: 'S',
  scopeName: 'source.s',
  path: 's.json',
  extensions
})

describe('pluginTryAction', () => {
  it('has a sample for a known grammar, matched ignoring case', () => {
    expect(pluginSyntaxSample([{ extensions: ['.GLEAM'] }])?.content).toContain('pub fn main')
    expect(pluginTryAction('acme.p', manifest({ syntaxes: [syntax(['.gleam'])] }))).toBeTypeOf(
      'function'
    )
  })

  it('offers nothing for a grammar without a sample or a theme-only plugin', () => {
    expect(pluginTryAction('acme.p', manifest({ syntaxes: [syntax(['.zzz'])] }))).toBeNull()
    expect(
      pluginTryAction(
        'acme.p',
        manifest({ themes: [{ id: 'd', title: 'D', path: 'themes/d.json' }] })
      )
    ).toBeNull()
  })
})
