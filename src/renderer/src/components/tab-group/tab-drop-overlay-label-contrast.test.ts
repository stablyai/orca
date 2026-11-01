import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const assets = join(__dirname, '../../assets')
const mainCss = readFileSync(join(assets, 'main.css'), 'utf8')
const terminalCss = readFileSync(join(assets, 'terminal.css'), 'utf8')

type Rgb = [number, number, number]

function hex(value: string): Rgb {
  const digits = value.slice(1)
  const h = digits.length === 3 ? digits.replace(/./g, (c) => c + c) : digits
  const channel = (i: number): number => Number.parseInt(h.slice(i, i + 2), 16)
  return [channel(0), channel(2), channel(4)]
}

function tokenIn(block: string, name: string): Rgb {
  const match = new RegExp(`${name}:\\s*(#[0-9a-fA-F]{3,6})\\s*;`).exec(block)
  if (!match?.[1]) {
    throw new Error(`Missing ${name}`)
  }
  return hex(match[1])
}

function luminance([r, g, b]: Rgb): number {
  const lin = (c: number): number => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi! + 0.05) / (lo! + 0.05)
}

function blend(top: Rgb, alpha: number, under: Rgb): Rgb {
  const mix = (i: number): number => top[i]! * alpha + under[i]! * (1 - alpha)
  return [mix(0), mix(1), mix(2)]
}

/** The declarations of the rule with exactly this selector. */
function ruleBody(css: string, selector: string): string {
  const start = css.indexOf(`\n${selector} {`)
  if (start === -1) {
    throw new Error(`Missing rule ${selector}`)
  }
  return css.slice(start, css.indexOf('}', start))
}

const themes = [
  ['light', mainCss.slice(mainCss.indexOf(':root {'), mainCss.indexOf('\n.dark {'))],
  [
    'dark',
    mainCss.slice(mainCss.indexOf('\n.dark {'), mainCss.indexOf('\n.native-chat-appearance'))
  ]
] as const

describe('drop overlay label contrast', () => {
  const label = ruleBody(terminalCss, '.tab-drop-overlay__label')

  it('uses the theme foreground on a mostly opaque theme background', () => {
    expect(label).toMatch(/color:\s*var\(--foreground\)/)
    expect(label).toMatch(
      /background:\s*color-mix\(in srgb, var\(--background\) \d+%, transparent\)/
    )
  })

  it.each(themes)(
    'reads at 4.5:1 or better in the %s theme over any terminal colour',
    (_n, block) => {
      const share = Number(/var\(--background\) (\d+)%/.exec(label)?.[1] ?? 0) / 100
      const fg = tokenIn(block, '--foreground')
      const bg = tokenIn(block, '--background')
      // Worst case is the terminal colour that pulls the background mix furthest from the text.
      const backdrops: Rgb[] = [
        [0, 0, 0],
        [255, 255, 255]
      ]
      for (const behind of backdrops) {
        expect(contrast(fg, blend(bg, share, behind))).toBeGreaterThanOrEqual(4.5)
      }
    }
  )

  // The refused label carries the reason, so it keeps a readable surface pair; the dashed frame marks it disabled.
  const disabledLabel = ruleBody(
    terminalCss,
    '.tab-drop-overlay[data-disabled] .tab-drop-overlay__label'
  )

  it.each(themes)('reads the refusal reason at 4.5:1 or better in the %s theme', (_n, block) => {
    expect(disabledLabel).toMatch(/color:\s*var\(--foreground\);/)
    expect(disabledLabel).toMatch(/background:\s*var\(--background\);/)
    expect(
      contrast(tokenIn(block, '--foreground'), tokenIn(block, '--background'))
    ).toBeGreaterThanOrEqual(4.5)
  })
})
