import { describe, expect, it } from 'vitest'
import { claudeRichOutputAssetFilenames } from './claude-rich-output-artifacts'

describe('rich output deployment inventory', () => {
  it('accepts scoped dependencies and returns deterministic copy order', () => {
    const assets = [
      'claude-rich-output/reply-media/hooks/register.tsx',
      'claude-rich-output/node_modules/@mathjax/src/bundle/tex-svg.js'
    ]
    expect(claudeRichOutputAssetFilenames(JSON.stringify({ assets }))).toEqual([...assets].sort())
  })

  it.each([
    '../outside.js',
    'claude-rich-output/../../outside.js',
    'claude-rich-output/a/./b.js',
    'claude-rich-output/a\\..\\outside.js',
    'claude-rich-output/C:outside.js',
    'claude-rich-output/manifest.json'
  ])('rejects copy destinations outside the payload: %s', (path) => {
    expect(() => claudeRichOutputAssetFilenames(JSON.stringify({ assets: [path] }))).toThrow()
  })

  it('rejects duplicates and empty inventories', () => {
    const path = 'claude-rich-output/reply-media/render/math.mjs'
    expect(() => claudeRichOutputAssetFilenames(JSON.stringify({ assets: [path, path] }))).toThrow()
    expect(() => claudeRichOutputAssetFilenames(JSON.stringify({ assets: [] }))).toThrow()
  })

  it('accepts the bounded inventory and rejects overflow', () => {
    const assets = Array.from({ length: 20000 }, (_, index) => `claude-rich-output/${index}.mjs`)
    expect(claudeRichOutputAssetFilenames(JSON.stringify({ assets }))).toHaveLength(20000)
    assets.push('claude-rich-output/overflow.mjs')
    expect(() => claudeRichOutputAssetFilenames(JSON.stringify({ assets }))).toThrow(
      'Invalid Claude rich output asset manifest'
    )
  })
})
