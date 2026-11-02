import { describe, expect, it } from 'vitest'
import { parsePluginManifest } from '../manifest/plugin-manifest'
import { pluginSettingValueIssue } from './plugin-settings-contribution'

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

  it('checks values the plugin or the person writes', () => {
    const pageSize = { type: 'integer' as const, minimum: 1, maximum: 100 }
    expect(pluginSettingValueIssue(pageSize, 50)).toBeNull()
    expect(pluginSettingValueIssue(pageSize, 0)).toBe('must be at least 1')
    expect(pluginSettingValueIssue(pageSize, '5')).toBe('must be an integer')
    expect(pluginSettingValueIssue({ type: 'string', enum: ['a', 'b'] }, 'c')).toContain('one of')
    expect(pluginSettingValueIssue({ type: 'string', maxLength: 3 }, 'abcd')).toContain(
      '3 characters'
    )
  })
})
