import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  getAppBackgroundHostProps,
  resolveAppBackgroundAppearance,
  resolveTranslucentPaneTitleBackground
} from './app-background-appearance'

const IMAGE_ID = '11111111-1111-4111-8111-111111111111.png'

describe('resolveAppBackgroundAppearance', () => {
  it('is null without a saved image so nothing renders differently', () => {
    expect(resolveAppBackgroundAppearance(null, false)).toBeNull()
    expect(resolveAppBackgroundAppearance({ appBackgroundImageId: null }, false)).toBeNull()
    expect(
      resolveAppBackgroundAppearance({ appBackgroundImageId: '../escape.png' }, false)
    ).toBeNull()
  })

  it('is null on the web client even with a saved image', () => {
    expect(resolveAppBackgroundAppearance({ appBackgroundImageId: IMAGE_ID }, true)).toBeNull()
  })

  it('fills defaults and clamps values', () => {
    expect(
      resolveAppBackgroundAppearance(
        { appBackgroundImageId: IMAGE_ID, appBackgroundBlur: 99, appBackgroundPanelOpacity: 0 },
        false
      )
    ).toEqual({
      imageId: IMAGE_ID,
      scope: 'window',
      imageOpacity: 1,
      blur: 20,
      panelOpacity: 0.2
    })
  })
})

describe('getAppBackgroundHostProps', () => {
  it('sets the scope attribute and the unitless panel opacity variable', () => {
    expect(getAppBackgroundHostProps('workspace', 0.55)).toEqual({
      'data-app-background': 'workspace',
      style: { '--app-panel-opacity': '0.55' }
    })
  })

  it('clamps the panel opacity', () => {
    expect(getAppBackgroundHostProps('window', 5).style['--app-panel-opacity']).toBe('1')
  })
})

describe('resolveTranslucentPaneTitleBackground', () => {
  it('mixes the raw terminal background at the terminal opacity', () => {
    expect(resolveTranslucentPaneTitleBackground('#282c34', 0.6)).toBe(
      'color-mix(in srgb, #282c34 60%, transparent)'
    )
  })

  it('defers to the opaque title color when the terminal is opaque or unknown', () => {
    expect(resolveTranslucentPaneTitleBackground('#282c34', undefined)).toBeNull()
    expect(resolveTranslucentPaneTitleBackground('#282c34', 1)).toBeNull()
    expect(resolveTranslucentPaneTitleBackground(undefined, 0.5)).toBeNull()
  })
})

describe('main.css panel alpha curves', () => {
  const css = readFileSync(resolve('src/renderer/src/assets/main.css'), 'utf8')
  const curves = [
    ...css.matchAll(/--app-panel-alpha: calc\(var\(--app-panel-opacity, 1\) \* (\d+)%\)/g)
  ].map((match) => Number(match[1]))

  it('fades light panels harder than dark ones', () => {
    // White overlays flatten an image far more than black ones at the same alpha.
    expect(curves).toEqual([65, 85])
  })
})

describe('main.css window host stacking', () => {
  const css = readFileSync(resolve('src/renderer/src/assets/main.css'), 'utf8')

  it('keeps the app-root host out of its own stacking context', () => {
    // An isolated app root traps the inline toaster under body-portaled dialog overlays.
    expect(css).toMatch(/\.app-layout\[data-app-background\] \{\s*isolation: auto;/)
  })
})

describe('main.css background surface', () => {
  const css = readFileSync(resolve('src/renderer/src/assets/main.css'), 'utf8')

  it('fades opaque --background fills such as the landing page', () => {
    expect(css).toMatch(
      /\[data-app-background\] \[data-app-background-surface='background'\] \{\s*background: color-mix\(in srgb, var\(--background\) var\(--app-panel-alpha\), transparent\);/
    )
  })
})
