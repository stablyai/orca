import fs from 'node:fs'
import { describe, expect, it } from 'vitest'

/** Reads a source file relative to this test so the assertions track the shipped CSS and classes. */
const read = (relative: string): string =>
  fs.readFileSync(new URL(relative, import.meta.url), 'utf8')

const mainCss = read('../../assets/main.css')

type Rgb = number[]

/** Parses the hex and `rgb(r g b / a)` literals main.css uses for theme tokens. */
function parseColor(value: string): { rgb: Rgb; alpha: number } {
  const hex = value.match(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/)
  if (hex) {
    const digits = hex[1].length === 3 ? hex[1].replace(/./g, '$&$&') : hex[1]
    const rgb = [0, 2, 4].map((i) => Number.parseInt(digits.slice(i, i + 2), 16))
    return { rgb, alpha: 1 }
  }
  const rgbFn = value.match(/^rgb\((\d+) (\d+) (\d+) \/ ([\d.]+)\)$/)
  if (rgbFn) {
    return { rgb: [+rgbFn[1], +rgbFn[2], +rgbFn[3]], alpha: Number(rgbFn[4]) }
  }
  throw new Error(`unsupported color literal: ${value}`)
}

/** Alpha-composites `top` onto an opaque `bottom`, as the browser paints a translucent layer. */
function over(top: Rgb, alpha: number, bottom: Rgb): Rgb {
  return top.map((c, i) => c * alpha + bottom[i] * (1 - alpha))
}

/** WCAG 2.x relative luminance. */
function luminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map((channel) => {
    const c = channel / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG contrast ratio, independent of which color is lighter. */
function contrastRatio(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

const darkStart = mainCss.indexOf('\n.dark {')
const themeBlocks = {
  light: mainCss.slice(0, darkStart),
  dark: mainCss.slice(darkStart, mainCss.indexOf('\n}', darkStart))
}

/** Resolves a CSS custom property's literal value within one theme block. */
function token(block: string, name: string): string {
  const match = block.match(new RegExp(`\\n\\s*${name}:\\s*([^;]+);`))
  if (!match) {
    throw new Error(`${name} not found in theme block`)
  }
  return match[1].trim()
}

/** Tailwind `/NN` opacity modifier on a class, or 100 when absent. */
function classOpacity(source: string, utility: string): number {
  const match = source.match(new RegExp(`(?:^|[\\s'"])${utility}(?:/(\\d+))?(?=[\\s'"])`))
  if (!match) {
    throw new Error(`${utility} not found`)
  }
  return match[1] ? Number(match[1]) / 100 : 1
}

const fields = {
  Input: read('./input.tsx'),
  Textarea: read('./textarea.tsx')
}

describe('field placeholder contrast', () => {
  for (const [component, source] of Object.entries(fields)) {
    for (const [theme, block] of Object.entries(themeBlocks)) {
      it(`${component} placeholder meets WCAG AA (4.5:1) in the ${theme} theme`, () => {
        const page = parseColor(token(block, '--background')).rgb
        // Light fields are bg-transparent; dark fields add dark:bg-input/30.
        let field = page
        if (theme === 'dark') {
          const input = parseColor(token(block, '--input'))
          field = over(input.rgb, input.alpha * classOpacity(source, 'dark:bg-input'), page)
        }
        const placeholder = over(
          parseColor(token(block, '--muted-foreground')).rgb,
          classOpacity(source, 'placeholder:text-muted-foreground'),
          field
        )
        expect(contrastRatio(placeholder, field)).toBeGreaterThanOrEqual(4.5)
      })
    }
  }
})
