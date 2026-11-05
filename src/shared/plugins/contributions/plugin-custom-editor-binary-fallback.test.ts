import { describe, expect, it } from 'vitest'
import { parsePluginManifest } from '../manifest/plugin-manifest'
import { pluginUpdateAccessGrowth } from '../approval/plugin-update-access-growth'
import { canonicalizePluginConsent } from '../approval/plugin-consent-fingerprint'
import { getPluginActivationState } from '../approval/plugin-consent-state'

const editor = { id: 'hex', title: 'Hex', entry: 'editor.html', contentKind: 'bytes' }
function raw(customEditor: Record<string, unknown>, floor = '>=1.4.250') {
  return {
    manifestVersion: 2,
    execution: 'sandboxed-ui',
    id: 'binary',
    publisher: 'acme',
    name: 'Binary',
    version: '1.0.0',
    engines: { orca: floor },
    contributes: { customEditors: [customEditor] }
  }
}
function manifest(customEditor: Record<string, unknown>) {
  const result = parsePluginManifest(raw(customEditor))
  if (!result.ok) {
    throw new Error(result.error)
  }
  return result.manifest
}

describe('binary fallback declaration and approval', () => {
  it('admits filename-independent bytes fallback only at the planned supporting floor', () => {
    expect(parsePluginManifest(raw({ ...editor, binaryFallback: true }))).toMatchObject({
      ok: true
    })
    expect(
      parsePluginManifest(raw({ ...editor, binaryFallback: true }, '>=1.4.249'))
    ).toMatchObject({ ok: false })
    expect(
      parsePluginManifest(raw({ ...editor, binaryFallback: true, contentKind: 'text' }))
    ).toMatchObject({ ok: false })
    expect(parsePluginManifest(raw({ ...editor, binaryFallback: false }))).toMatchObject({
      ok: false
    })
    expect(parsePluginManifest(raw({ ...editor }))).toMatchObject({ ok: false })
  })

  it('requires new consent when a same editor gains broad binary reach, including dev reloads', () => {
    const narrow = manifest({ ...editor, extensions: ['.bin'] })
    const disabled = manifest({ ...editor, extensions: ['.bin'], binaryFallback: false })
    const broad = manifest({ ...editor, extensions: ['.bin'], binaryFallback: true })
    expect(pluginUpdateAccessGrowth(narrow, broad).contributions).toEqual(['customEditors'])
    expect(pluginUpdateAccessGrowth(disabled, broad).contributions).toEqual(['customEditors'])
    expect(pluginUpdateAccessGrowth(broad, narrow).contributions).toEqual([])
    const before = canonicalizePluginConsent(narrow, 'dev-tree')
    const after = canonicalizePluginConsent(broad, 'dev-tree')
    expect(canonicalizePluginConsent(disabled, 'dev-tree')).toBe(before)
    expect(after).not.toBe(before)
    expect(
      getPluginActivationState('acme.binary', after, {
        pluginConsents: { 'acme.binary': before },
        disabledPlugins: []
      })
    ).toBe('pending')
  })
})
