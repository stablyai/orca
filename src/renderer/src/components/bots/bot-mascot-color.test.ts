import { describe, expect, it } from 'vitest'
import { recolorMascotSvg } from './bot-mascot-color'

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
