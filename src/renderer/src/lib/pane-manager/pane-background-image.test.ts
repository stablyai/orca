// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { applyRootBackgroundImage, PANE_BACKGROUND_IMAGE_CLASS } from './pane-background-image'

const IMAGE = 'data:image/png;base64,AAAA'

describe('applyRootBackgroundImage', () => {
  it('publishes the image layer through CSS variables on the root', () => {
    const root = document.createElement('div')

    applyRootBackgroundImage(root, {
      backgroundImage: IMAGE,
      backgroundImageOpacity: 0.4,
      backgroundImageFit: 'contain'
    })

    expect(root.classList.contains(PANE_BACKGROUND_IMAGE_CLASS)).toBe(true)
    expect(root.style.getPropertyValue('--pane-background-image')).toBe(`url("${IMAGE}")`)
    expect(root.style.getPropertyValue('--pane-background-image-opacity')).toBe('0.4')
    expect(root.style.getPropertyValue('--pane-background-image-size')).toBe('contain')
  })

  it('falls back to the default opacity when unset', () => {
    const root = document.createElement('div')

    applyRootBackgroundImage(root, { backgroundImage: IMAGE })

    expect(root.style.getPropertyValue('--pane-background-image-opacity')).toBe('0.15')
    expect(root.style.getPropertyValue('--pane-background-image-size')).toBe('cover')
  })

  it('clears the layer when the image is removed', () => {
    const root = document.createElement('div')
    applyRootBackgroundImage(root, { backgroundImage: IMAGE })

    applyRootBackgroundImage(root, { backgroundImage: null })

    expect(root.classList.contains(PANE_BACKGROUND_IMAGE_CLASS)).toBe(false)
    expect(root.style.getPropertyValue('--pane-background-image')).toBe('')
    expect(root.style.getPropertyValue('--pane-background-image-opacity')).toBe('')
  })
})
