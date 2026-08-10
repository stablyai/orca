import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

/**
 * Orca's fixes for the WebGL glyph-atlas thrash live in
 * config/patches/@xterm__addon-webgl@*.patch, hand-applied to the shipped
 * bundles. A version bump that regenerates the patch drops them silently and the
 * only symptom is garbled CJK panes in production, so gate them here.
 */
const require = createRequire(import.meta.url)
const packageRoot = dirname(require.resolve('@xterm/addon-webgl/package.json'))
const BUNDLES = ['lib/addon-webgl.mjs', 'lib/addon-webgl.js'] as const

function readBundle(relativePath: string): string {
  return readFileSync(join(packageRoot, relativePath), 'utf8')
}

describe.each(BUNDLES)('@xterm/addon-webgl bundle %s', (relativePath) => {
  it('still carries the merge-retry loop the exhaustion guard hangs off', () => {
    expect(readBundle(relativePath)).toMatch(
      /for\(;this\._charAtlas&&\w+\+\+<32&&this\._glyphRenderer\.value\.beginFrame\(\);\)/
    )
  })

  it('requests another frame when the merge-retry budget is exhausted', () => {
    // Without this the model stays half-built against page indexes the last
    // merge invalidated, and only an unrelated resize ever repairs the pane.
    expect(readBundle(relativePath)).toMatch(
      /\w+>32\?\(this\._exhaustedMergeFrames=\(this\._exhaustedMergeFrames\|\|0\)\+1\)<=4&&this\._requestRedrawViewport\(\):this\._exhaustedMergeFrames=0/
    )
  })

  it('allocates 1024px atlas pages so a CJK viewport fits the texture budget', () => {
    expect(readBundle(relativePath)).toContain('_textureSize=1024')
    expect(readBundle(relativePath)).not.toContain('_textureSize=512')
  })
})
