import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_INTERFACE_THEME_ID,
  INTERFACE_THEMES_DARK,
  INTERFACE_THEMES_LIGHT
} from './interface-themes'

const css = readFileSync(join(__dirname, '../renderer/src/assets/interface-themes.css'), 'utf8')

describe('interface themes', () => {
  it('has a stylesheet palette for every non-default catalog entry', () => {
    for (const { id } of INTERFACE_THEMES_DARK.filter((t) => t.id !== DEFAULT_INTERFACE_THEME_ID)) {
      expect(css).toContain(`.dark.ui-dark-${id} {`)
    }
    for (const { id } of INTERFACE_THEMES_LIGHT.filter(
      (t) => t.id !== DEFAULT_INTERFACE_THEME_ID
    )) {
      expect(css).toContain(`.light.ui-light-${id} {`)
    }
  })
})
