import { describe, expect, it } from 'vitest'
import {
  pluginInstalledImageUrl,
  pluginPanelIconUrl,
  pluginShaImageUrl,
  servedPluginHostImages
} from './plugin-image-url'

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
})

describe('pluginPanelIconUrl', () => {
  it('accepts only a canonical panel icon slot', () => {
    const url = pluginInstalledImageUrl('acme.icons', 'a'.repeat(64), 'panel-icon-3')
    expect(pluginPanelIconUrl(`${url}?v=1#fragment`)).toBe(url)
    expect(
      pluginPanelIconUrl(pluginInstalledImageUrl('acme.icons', 'a'.repeat(64), 'icon'))
    ).toBeNull()
    expect(pluginPanelIconUrl('https://evil.example/panel-icon-0')).toBeNull()
  })
})
