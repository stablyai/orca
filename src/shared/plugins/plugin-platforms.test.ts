import { describe, expect, it } from 'vitest'
import { parsePluginManifest } from './plugin-manifest'
import { isPluginPlatformSupported } from './plugin-platforms'

function manifest(platforms?: unknown): unknown {
  return {
    manifestVersion: 1,
    id: 'demo',
    publisher: 'orca-samples',
    name: 'Demo',
    version: '1.0.0',
    engines: { orca: '>=1.0.0' },
    pluginApi: 1,
    ...(platforms === undefined ? {} : { platforms }),
    capabilities: []
  }
}

describe('manifest platforms', () => {
  it('is optional and keeps the declared list', () => {
    const absent = parsePluginManifest(manifest())
    expect(absent.ok && absent.manifest.platforms).toBeUndefined()
    const declared = parsePluginManifest(manifest(['darwin', 'win32']))
    expect(declared.ok && declared.manifest.platforms).toEqual(['darwin', 'win32'])
  })

  it.each([
    [[], 'Too small'],
    [['darwin', 'darwin'], 'duplicate platform'],
    [['freebsd'], 'platforms.0'],
    ['darwin', 'platforms']
  ])('rejects %j', (platforms, error) => {
    const parsed = parsePluginManifest(manifest(platforms))
    expect(parsed.ok).toBe(false)
    expect(JSON.stringify(parsed)).toContain(error)
  })
})

describe('isPluginPlatformSupported', () => {
  it('treats an absent list as every platform and otherwise matches exactly', () => {
    expect(isPluginPlatformSupported(undefined, 'freebsd')).toBe(true)
    expect(isPluginPlatformSupported(['darwin', 'linux'], 'linux')).toBe(true)
    expect(isPluginPlatformSupported(['darwin'], 'win32')).toBe(false)
  })
})
