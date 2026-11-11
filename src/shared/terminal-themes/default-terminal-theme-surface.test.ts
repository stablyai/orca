import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_TERMINAL_THEMES } from './defaults'
import {
  DEFAULT_TERMINAL_THEME_DARK,
  DEFAULT_TERMINAL_THEME_LIGHT
} from './terminal-theme-selection'

const css = readFileSync(join(__dirname, '../../renderer/src/assets/main.css'), 'utf8')

/** The first `--background` declared in the block that starts with `selector {`. */
function appBackground(selector: string): string | null {
  const start = css.indexOf(`\n${selector} {`)
  if (start === -1) {
    return null
  }
  const block = css.slice(start, css.indexOf('\n}', start))
  return (
    block
      .match(/\n\s*--background:\s*([^;]+);/)?.[1]
      ?.trim()
      .toLowerCase() ?? null
  )
}

describe('default terminal themes follow the app surface', () => {
  it('dark: the default dark terminal background is the app dark background', () => {
    const dark = DEFAULT_TERMINAL_THEMES[DEFAULT_TERMINAL_THEME_DARK]
    const appDark = css
      .split('\n.dark {')
      .slice(1)
      .map(
        (block) => block.slice(0, block.indexOf('\n}')).match(/\n\s*--background:\s*([^;]+);/)?.[1]
      )
      .find((value): value is string => Boolean(value))
      ?.trim()
      .toLowerCase()
    expect(appDark).toBeTruthy()
    expect(dark.background?.toLowerCase()).toBe(appDark)
    expect(dark.cursorAccent?.toLowerCase()).toBe(appDark)
  })

  it('light: the default light terminal background is the app light background', () => {
    const light = DEFAULT_TERMINAL_THEMES[DEFAULT_TERMINAL_THEME_LIGHT]
    const appLight = appBackground(':root')
    expect(appLight).toBeTruthy()
    const normalize = (value: string) =>
      value.length === 4 ? `#${value.slice(1).replace(/(.)/g, '$1$1')}` : value
    expect(normalize(light.background?.toLowerCase() ?? '')).toBe(normalize(appLight ?? ''))
  })
})
