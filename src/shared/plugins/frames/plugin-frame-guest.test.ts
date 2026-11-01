import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  isPluginFrameOriginUrl,
  parsePluginFrameUrl,
  pluginFrameKey,
  pluginFramePartition,
  pluginFrameUrl,
  readPluginFramePartitionKey
} from './plugin-frame-guest'

const KEY = pluginFrameKey('acme.charts')

describe('plugin frame guest identity', () => {
  it('derives the key as the first 16 hex chars of sha256(publisher.id)', () => {
    expect(KEY).toBe(createHash('sha256').update('acme.charts').digest('hex').slice(0, 16))
    expect(pluginFrameKey('acme.other')).not.toBe(KEY)
  })

  it('round-trips the partition and refuses look-alikes', () => {
    expect(pluginFramePartition(KEY)).toBe(`persist:orca-plugin-${KEY}`)
    expect(readPluginFramePartitionKey(pluginFramePartition(KEY))).toBe(KEY)
    expect(readPluginFramePartitionKey(`persist:orca-plugin-${KEY}x`)).toBeNull()
    expect(readPluginFramePartitionKey(`orca-plugin-${KEY}`)).toBeNull()
    expect(readPluginFramePartitionKey('persist:orca-plugin-../../x')).toBeNull()
  })
})

describe('plugin frame URLs', () => {
  it('builds entry URLs from manifest paths', () => {
    expect(pluginFrameUrl(KEY, 'ui/panel.html')).toBe(`orca-plugin-frame://${KEY}/ui/panel.html`)
    expect(pluginFrameUrl(KEY, './a b/#x.html')).toBe(`orca-plugin-frame://${KEY}/a%20b/%23x.html`)
  })

  it('parses contained paths into decoded segments', () => {
    expect(parsePluginFrameUrl(`orca-plugin-frame://${KEY}/ui/app.js?v=1`)).toEqual({
      frameKey: KEY,
      segments: ['ui', 'app.js'],
      reserved: false
    })
    expect(parsePluginFrameUrl(`orca-plugin-frame://${KEY}/a%20b/x.wasm`)?.segments).toEqual([
      'a b',
      'x.wasm'
    ])
    expect(parsePluginFrameUrl(`orca-plugin-frame://${KEY}/__orca/sdk.js`)?.reserved).toBe(true)
    expect(parsePluginFrameUrl(`orca-plugin-frame://${KEY}/__ORCA/sdk.js`)?.reserved).toBe(true)
    expect(parsePluginFrameUrl(`orca-plugin-frame://${KEY}/__Orca/sdk.js`)?.reserved).toBe(true)
  })

  it('lets URL dot segments collapse at the plugin root, never above it', () => {
    expect(
      parsePluginFrameUrl(`orca-plugin-frame://${KEY}/ui/%2e%2e/%2e%2e/../secret`)?.segments
    ).toEqual(['secret'])
  })

  it.each([
    `orca-plugin-frame://${KEY}/`,
    `orca-plugin-frame://${KEY}/..%2Fsecret`,
    `orca-plugin-frame://${KEY}/a%5C..%5Cb`,
    `orca-plugin-frame://${KEY}/a%00b`,
    `orca-plugin-frame://${KEY}/__orca./runtime.mjs`,
    `orca-plugin-frame://${KEY}/__orca%20/runtime.mjs`,
    `orca-plugin-frame://${KEY}/panel.html.`,
    `orca-plugin-frame://${KEY}/C:%5Cwindows`,
    `orca-plugin-frame://${KEY}/bad%E0%A4%A`,
    `orca-plugin-frame://${KEY}:8080/x`,
    `orca-plugin-frame://user@${KEY}/x`,
    'orca-plugin-frame://NOTAKEY/x',
    `https://${KEY}/x`
  ])('refuses %s', (url) => {
    expect(parsePluginFrameUrl(url)).toBeNull()
  })

  it('matches only the exact plugin origin', () => {
    expect(isPluginFrameOriginUrl(`orca-plugin-frame://${KEY}/x.html`, KEY)).toBe(true)
    expect(isPluginFrameOriginUrl(`orca-plugin-frame://${pluginFrameKey('a.b')}/x`, KEY)).toBe(
      false
    )
    expect(isPluginFrameOriginUrl(`blob:orca-plugin-frame://${KEY}/uuid`, KEY)).toBe(false)
    expect(isPluginFrameOriginUrl('not a url', KEY)).toBe(false)
  })
})
