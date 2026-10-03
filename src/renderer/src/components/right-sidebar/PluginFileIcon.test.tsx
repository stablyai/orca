import { describe, expect, it } from 'vitest'
import { PluginFileIcon } from './PluginFileIcon'

const asset = {
  src: 'data:image/svg+xml;base64,PHN2Zy8+' as const,
  monochrome: false
}

describe('PluginFileIcon', () => {
  it('renders an unmodified multicolor icon as an image', () => {
    const icon = PluginFileIcon({ asset })

    expect(icon.type).toBe('img')
    expect(icon.props.src).toBe(asset.src)
  })

  it('uses the icon silhouette as a mask for an exact folder color', () => {
    const icon = PluginFileIcon({ asset, color: '#C90161' })

    expect(icon.type).toBe('span')
    expect(icon.props.style).toMatchObject({
      backgroundColor: '#C90161',
      maskImage: `url(${asset.src})`
    })
  })
})
