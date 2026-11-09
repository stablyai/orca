import { describe, expect, it } from 'vitest'
import { pluginShaImageUrl, servedPluginHostImages } from './plugin-image-url'

const served = { url: pluginShaImageUrl('a'.repeat(64)), alt: 'Cover' }

describe('servedPluginHostImages', () => {
  it('keeps only images main serves over the plugin image scheme', () => {
    const hotlinked = (url: string) => ({ url, alt: 'x' })
    expect(
      servedPluginHostImages({
        icon: hotlinked('https://tracker.example/pixel.png'),
        cover: served,
        screenshots: [hotlinked('data:image/svg+xml,<svg/>'), served, hotlinked('file:///etc/x')]
      })
    ).toEqual({ cover: served, screenshots: [served] })
  })

  it('drops everything when no image is served', () => {
    expect(servedPluginHostImages({ cover: { url: 'http://x/y.png', alt: 'x' } })).toEqual({})
  })
})
