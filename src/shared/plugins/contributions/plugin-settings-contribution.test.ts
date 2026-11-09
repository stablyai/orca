import { describe, expect, it } from 'vitest'
import { parsePluginManifest } from '../manifest/plugin-manifest'

function manifest(settings: unknown[], capabilities = [{ kind: 'settings:own' }]) {
  return {
    manifestVersion: 2,
    execution: 'sandboxed-ui',
    id: 'settings-demo',
    name: 'Settings demo',
    version: '1.0.0',
    engines: { orca: '>=1.4.246' },
    contributes: { panels: [{ id: 'p', title: 'P', entry: 'p.html' }], settings },
    capabilities
  }
}

const apiUrl = {
  key: 'apiUrl',
  title: 'Server URL',
  type: 'string',
  default: 'https://example.com'
}

function issues(raw: unknown): string {
  const parsed = parsePluginManifest(raw)
  return parsed.ok ? '' : parsed.error
}

describe('contributes.settings', () => {
  it('needs settings:own, unique keys, and defaults that fit the setting', () => {
    expect(issues(manifest([apiUrl], []))).toContain('settings:own')
    expect(issues(manifest([apiUrl, apiUrl]))).toContain('duplicate setting key')
    expect(issues(manifest([{ ...apiUrl, default: 3 }]))).toContain('must be a string')
    expect(issues(manifest([{ key: 'n', title: 'N', type: 'integer', default: 1.5 }]))).toContain(
      'integer'
    )
    expect(
      issues(manifest([{ key: 'm', title: 'M', type: 'string', enum: ['a'], enumLabels: [] }]))
    ).toContain('one label per enum value')
    expect(issues(manifest([{ ...apiUrl, key: '1bad' }]))).toContain('starts with a letter')
  })
})
