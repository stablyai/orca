import { describe, expect, it } from 'vitest'
import { dressMascotSvg, recolorMascotSvg } from './bot-mascot-look'

const SVG =
  '<svg><rect style="fill:var(--avatar-bg,#b3dbf4)"/><g style="opacity:var(--avatar-rim,0)"/></svg>'

describe('recolorMascotSvg', () => {
  it('fills the background and keeps the rim off on a light color', () => {
    expect(recolorMascotSvg(SVG, '#f4c4cf')).toBe(
      '<svg><rect style="fill:#f4c4cf"/><g style="opacity:var(--avatar-rim,0)"/></svg>'
    )
  })

  it('turns the light rim on over a dark color', () => {
    expect(recolorMascotSvg(SVG, '#1f2126')).toBe(
      '<svg><rect style="fill:#1f2126"/><g style="opacity:1"/></svg>'
    )
  })
})

const DRESSABLE = '<svg><g><g><g id="body"/><g id="face"><circle r="1"/></g></g></g></svg>\n'

describe('dressMascotSvg', () => {
  it('draws the outfit over the picture', () => {
    expect(dressMascotSvg(DRESSABLE, { layer: '<g id="outfit"/>' })).toBe(
      '<svg><g><g><g id="body"/><g id="face"><circle r="1"/></g></g></g><g id="outfit"/></svg>'
    )
  })

  it('swaps the face when the outfit has one', () => {
    expect(dressMascotSvg(DRESSABLE, { layer: '<g id="outfit"/>', face: '<circle r="2"/>' })).toBe(
      '<svg><g><g><g id="body"/><g id="face"><circle r="2"/></g></g></g><g id="outfit"/></svg>'
    )
  })
})
