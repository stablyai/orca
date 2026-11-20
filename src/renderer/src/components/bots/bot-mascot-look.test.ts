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

const DRESSABLE =
  '<svg><defs><path d="M1"/></defs><g><g><path d="M1"/><g id="face"><circle r="1"/></g></g></g></svg>\n'
const ART =
  '<image href="data:image/webp;base64,QQ" x="1" y="2" width="3" height="4" preserveAspectRatio="none"/>'

describe('dressMascotSvg', () => {
  it('draws the outfit over the picture', () => {
    expect(dressMascotSvg(DRESSABLE, { art: 'QQ', at: [1, 2, 3, 4] })).toBe(
      `<svg><defs><path d="M1"/></defs><g><g><path d="M1"/><g id="face"><circle r="1"/></g></g></g>${ART}</svg>`
    )
  })

  it('swaps the face and redraws body lines, leaving the defs alone', () => {
    expect(
      dressMascotSvg(DRESSABLE, {
        art: 'QQ',
        at: [1, 2, 3, 4],
        face: '<circle r="2"/>',
        redraw: [['M1', 'M2']]
      })
    ).toBe(
      `<svg><defs><path d="M1"/></defs><g><g><path d="M2"/><g id="face"><circle r="2"/></g></g></g>${ART}</svg>`
    )
  })
})
