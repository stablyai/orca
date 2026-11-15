import { expect, it } from 'vitest'
import { parseThemeColor, rgbaToOklch } from '../color/oklch-color-transform'
import { separateThemeStudioVariant } from './theme-studio-separate'

const lightness = (value: string | undefined): number => {
  const color = parseThemeColor(value ?? '')
  return color ? rgbaToOklch(color).l : Number.NaN
}

it('moves the whole sidebar group away from the canvas in either mode', () => {
  const dark = separateThemeStudioVariant(
    {
      tokens: {
        '--background': '#101010',
        '--foreground': '#eeeeee',
        '--sidebar': '#181818',
        '--worktree-sidebar': '#181818',
        '--card': '#181818'
      }
    },
    'sidebar',
    0.05
  )
  expect(dark.changed).toEqual(['--sidebar', '--worktree-sidebar'])
  expect(lightness(dark.variant.tokens['--sidebar']) - lightness('#181818')).toBeCloseTo(0.05, 2)
  expect(dark.variant.tokens['--card']).toBe('#181818')
  const light = separateThemeStudioVariant(
    {
      tokens: {
        '--background': '#ffffff',
        '--foreground': '#111111',
        '--worktree-sidebar': '#fafafa'
      }
    },
    'sidebar',
    0.05
  )
  expect(lightness(light.variant.tokens['--worktree-sidebar'])).toBeLessThan(lightness('#fafafa'))
})
