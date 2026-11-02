import { describe, expect, it } from 'vitest'
import { pluginPanelContributionSchema } from './plugin-panel-contribution'
import { parsePluginManifest } from '../manifest/plugin-manifest'
import { pluginManifestCompatibilityError } from '../manifest/plugin-manifest-compatibility'

const panel = { id: 'board', title: 'Board' }

function manifest(engine: string, panelFields: Record<string, unknown>) {
  return {
    manifestVersion: 2,
    execution: 'sandboxed-ui',
    id: 'board',
    publisher: 'acme',
    name: 'Board',
    version: '1.0.0',
    engines: { orca: engine },
    pluginApi: 1,
    contributes: { panels: [{ ...panel, entry: 'panel.js', ...panelFields }] }
  }
}

describe('panel ui', () => {
  it('defaults to an html panel and leaves the field absent', () => {
    const parsed = pluginPanelContributionSchema.parse({ ...panel, entry: 'panel.html' })
    expect(parsed).toEqual({ ...panel, entry: 'panel.html' })
  })

  it.each(['dist/panel.js', 'panel.mjs', 'Panel.JS', 'src/panel.tsx', 'panel.ts', 'panel.jsx'])(
    'accepts a components %s module',
    (entry) => {
      expect(
        pluginPanelContributionSchema.safeParse({ ...panel, entry, ui: 'components' }).success
      ).toBe(true)
    }
  )

  it.each(['panel.html', 'panel.d.css', 'panel.js.map'])(
    'refuses a components %s entry',
    (entry) => {
      const parsed = pluginPanelContributionSchema.safeParse({ ...panel, entry, ui: 'components' })
      expect(parsed.success).toBe(false)
      expect(parsed.error?.issues[0]).toMatchObject({ path: ['entry'] })
    }
  )

  it('refuses an unknown ui and the old runtime field', () => {
    expect(
      pluginPanelContributionSchema.safeParse({ ...panel, entry: 'panel.js', ui: 'native' }).success
    ).toBe(false)
    expect(
      pluginPanelContributionSchema.safeParse({
        ...panel,
        entry: 'panel.js',
        runtime: 'declarative'
      }).success
    ).toBe(false)
  })

  it('makes authors declare the release that reads ui and the newer icons', () => {
    expect(parsePluginManifest(manifest('>=1.4.245', { ui: 'components' })).ok).toBe(false)
    expect(parsePluginManifest(manifest('>=1.4.245', { icon: 'add' })).ok).toBe(false)
    expect(parsePluginManifest(manifest('>=1.4.245', { icon: 'rocket' })).ok).toBe(true)
    expect(parsePluginManifest(manifest('>=1.4.246', { ui: 'components', icon: 'add' })).ok).toBe(
      true
    )
  })

  it('lets an older Orca say which release it needs', () => {
    expect(
      pluginManifestCompatibilityError(manifest('>=1.4.246', { ui: 'components' }), '1.4.245')
    ).toBe('requires Orca >=1.4.246 (this is 1.4.245)')
  })
})
