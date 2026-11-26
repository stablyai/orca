import { describe, expect, it } from 'vitest'
import {
  pluginThemeBackgroundSchema,
  tolerantPluginThemeBackground
} from './plugin-theme-background'

describe('theme background chatOpacity', () => {
  it('clamps at runtime to the readable floor and keeps the image', () => {
    const chatOpacity = (value: unknown) =>
      tolerantPluginThemeBackground({ path: 'images/dusk.webp', chatOpacity: value })
    expect(chatOpacity(0.1)).toEqual({ path: 'images/dusk.webp', chatOpacity: 0.5 })
    expect(chatOpacity(0.6)?.chatOpacity).toBe(0.6)
    expect(chatOpacity(3)?.chatOpacity).toBe(1)
    expect(chatOpacity('0.6')).toEqual({ path: 'images/dusk.webp', chatOpacity: undefined })
    expect(
      pluginThemeBackgroundSchema.safeParse({ path: 'images/dusk.webp', chatOpacity: 0.4 }).success
    ).toBe(false)
  })
})
