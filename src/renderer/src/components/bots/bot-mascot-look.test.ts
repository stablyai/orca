import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { faceMascotSvg, recolorMascotSvg } from './bot-mascot-look'
import type { BotOutfitLayers } from './bot-outfit-art'

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

const FACEABLE =
  '<svg><defs><path d="M1"/></defs><g><g><path d="M1"/><g id="face"><circle r="1"/></g></g></g></svg>\n'

describe('faceMascotSvg', () => {
  it('swaps the face and redraws body lines, leaving the defs alone', () => {
    expect(
      faceMascotSvg(FACEABLE, {
        art: 'QQ',
        at: [1, 2, 3, 4],
        face: '<circle r="2"/>',
        redraw: [['M1', 'M2']]
      })
    ).toBe(
      '<svg><defs><path d="M1"/></defs><g><g><path d="M2"/><g id="face"><circle r="2"/></g></g></g></svg>'
    )
  })
})

describe('the reviewer on the bundled mascots', () => {
  const mascots = new URL('../../../../shared/bot-mascots/', import.meta.url)
  const layers: BotOutfitLayers = JSON.parse(
    readFileSync(new URL('outfits/reviewer.json', mascots), 'utf8')
  )

  const worn = Object.entries(layers).flatMap(([id, layer]) => (layer ? [{ id, layer }] : []))

  it.each(worn)('$id takes its looking-down face and body lines', ({ id, layer }) => {
    const svg = readFileSync(new URL(`${id}.svg`, mascots), 'utf8')
    const faced = faceMascotSvg(svg, layer)
    expect(faced).toContain(`<g id="face">${layer.face}</g>`)
    const body = faced.slice(faced.indexOf('</defs>'))
    for (const [from, to] of layer.redraw ?? []) {
      expect(body).not.toContain(`d="${from}"`)
      expect(body).toContain(`d="${to}"`)
    }
  })
})
