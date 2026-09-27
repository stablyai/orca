import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  WideGlyphFitter,
  getWideGlyphScript,
  type IWideGlyphBox,
  type IWideGlyphMetrics
} from '@xterm/addon-webgl/src/WideGlyphFit'
import { resolveTerminalFitWideGlyphs } from './terminal-wide-glyph-fit'

// The fitter ships in both xterm source patches (the addon cannot import new core files); these
// tests pin its sizing rules and that the two copies never drift apart.

const require = createRequire(import.meta.url)
const readInstalled = (name: string, file: string): string =>
  readFileSync(join(dirname(require.resolve(`${name}/package.json`)), file), 'utf8')

// Apple SD Gothic Neo / PingFang SC under SF Mono at 28 device px (14px on a 2x display).
const BOX: IWideGlyphBox = { span: 33.7, ascent: 26, descent: 7 }
const METRICS: Record<string, IWideGlyphMetrics> = {
  가: { width: 24.2, actualBoundingBoxAscent: 22.5, actualBoundingBoxDescent: 2 },
  뷁: { width: 24.2, actualBoundingBoxAscent: 22.5, actualBoundingBoxDescent: 2.2 },
  ㅎ: { width: 24.2, actualBoundingBoxAscent: 17.8, actualBoundingBoxDescent: -2.7 },
  中: { width: 28.4, actualBoundingBoxAscent: 23, actualBoundingBoxDescent: 3 },
  Ａ: { width: 28.4, actualBoundingBoxAscent: 20, actualBoundingBoxDescent: 0 },
  한: { width: 34, actualBoundingBoxAscent: 22.5, actualBoundingBoxDescent: 1.2 }
}
const DEFAULT_METRICS: IWideGlyphMetrics = {
  width: 24.2,
  actualBoundingBoxAscent: 20,
  actualBoundingBoxDescent: 1
}
const measure = (text: string): IWideGlyphMetrics => METRICS[text] ?? DEFAULT_METRICS

describe('xterm wide glyph fit', () => {
  it('ships byte-identical copies in the core and WebGL patches', () => {
    expect(readInstalled('@xterm/addon-webgl', 'src/WideGlyphFit.ts')).toBe(
      readInstalled('@xterm/xterm', 'src/browser/renderer/shared/WideGlyphFit.ts')
    )
  })

  it('classifies only the scripts a single fallback face draws', () => {
    expect(
      ['가', 'ㅎ', 'ᄀ', '中', '𠀀', 'か', 'カ'].map((c) => getWideGlyphScript(c.codePointAt(0)!))
    ).toEqual(['hangul', 'hangul', 'hangul', 'han', 'han', 'kana', 'kana'])
    expect(['Ａ', '。', '❤', 'H'].map((c) => getWideGlyphScript(c.codePointAt(0)!))).toEqual([
      undefined,
      undefined,
      undefined,
      undefined
    ])
  })

  it('grows a script until its tallest samples fill the line box, then centers it', () => {
    const fit = new WideGlyphFitter().fit('가', BOX, 'regular', measure)
    // The samples' 22.5 + 2.2 ink height caps the scale below the 33.7 / 24.2 of the width.
    const scale = 33 / 24.7
    expect(fit?.scale).toBeCloseTo(scale)
    expect(fit?.offset).toBeCloseTo((33.7 - 24.2 * scale) / 2)
    // Lowered just enough that the tallest sample's top stays under the line box's.
    expect(fit?.shift).toBeCloseTo(22.5 * scale - 26)
  })

  it('gives every glyph of a script one scale and baseline, even when its own ink is shorter', () => {
    const fitter = new WideGlyphFitter()
    const [short, tall] = [
      fitter.fit('ㅎ', BOX, 'regular', measure),
      fitter.fit('가', BOX, 'regular', measure)
    ]
    expect({ scale: short?.scale, shift: short?.shift }).toEqual({
      scale: tall?.scale,
      shift: tall?.shift
    })
  })

  it('never shrinks, moves or resizes glyphs that already fill their cells', () => {
    const fitter = new WideGlyphFitter()
    expect(fitter.fit('한', BOX, 'regular', measure)).toBeUndefined()
    const cramped = fitter.fit('가', { span: 33.7, ascent: 10, descent: 7 }, 'regular', measure)
    expect(cramped).toEqual({ scale: 1, offset: (33.7 - 24.2) / 2, shift: 0 })
  })

  it('never shrinks or raises a glyph taller than the line box, only centers it', () => {
    // A code point the samples miss, from a taller face: 35 + 9 exceeds the 33px box both ways.
    const tall = (text: string): IWideGlyphMetrics =>
      text === '똠'
        ? { width: 24.2, actualBoundingBoxAscent: 35, actualBoundingBoxDescent: 9 }
        : measure(text)
    expect(new WideGlyphFitter().fit('똠', BOX, 'regular', tall)).toEqual({
      scale: 1,
      offset: (33.7 - 24.2) / 2,
      shift: 0
    })
  })

  it('only centers wide glyphs outside the fitted scripts', () => {
    const fit = new WideGlyphFitter().fit('Ａ', BOX, 'regular', measure)
    expect(fit).toEqual({ scale: 1, offset: (33.7 - 28.4) / 2, shift: 0 })
  })

  it('keeps separate scales per font variant', () => {
    const fitter = new WideGlyphFitter()
    const bold = (text: string): IWideGlyphMetrics => ({
      ...measure(text),
      actualBoundingBoxAscent: 24
    })
    expect(fitter.fit('가', BOX, 'regular', measure)?.scale).toBeCloseTo(33 / 24.7)
    expect(fitter.fit('가', BOX, 'bold', bold)?.scale).toBeCloseTo(33 / 26.2)
  })

  it('is on unless the user turns it off', () => {
    expect(resolveTerminalFitWideGlyphs(undefined)).toBe(true)
    expect(resolveTerminalFitWideGlyphs(false)).toBe(false)
  })
})
