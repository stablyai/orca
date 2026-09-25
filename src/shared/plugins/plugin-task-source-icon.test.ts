import { describe, expect, it } from 'vitest'
import {
  buildPluginTaskSourceIconDataUrl,
  classifyPluginTaskSourceIcon,
  PLUGIN_TASK_SOURCE_ICON_MAX_BYTES
} from './plugin-task-source-icon'

const CLEAN_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M4 4h16v16H4z"/></svg>'

function decode(dataUrl: string): string {
  return Buffer.from(dataUrl.replace('data:image/svg+xml;base64,', ''), 'base64').toString('utf8')
}

describe('classifyPluginTaskSourceIcon', () => {
  it('reads a bare token as a Lucide name and a .svg as an asset', () => {
    expect(classifyPluginTaskSourceIcon('kanban')).toEqual({ kind: 'lucide', name: 'kanban' })
    expect(classifyPluginTaskSourceIcon('icons/board.svg')).toEqual({
      kind: 'asset',
      path: 'icons/board.svg'
    })
  })
})

describe('buildPluginTaskSourceIconDataUrl', () => {
  it('accepts a clean flat svg and encodes it as a base64 data URL', () => {
    const result = buildPluginTaskSourceIconDataUrl(CLEAN_SVG)

    expect(result.ok).toBe(true)
    expect(result.ok && result.dataUrl.startsWith('data:image/svg+xml;base64,')).toBe(true)
    expect(result.ok && decode(result.dataUrl)).toBe(CLEAN_SVG)
  })

  it('accepts a reference to a local #fragment', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg"><defs><path id="g" d="M0 0h1v1H0z"/></defs><use href="#g"/></svg>`

    expect(buildPluginTaskSourceIconDataUrl(svg).ok).toBe(true)
  })

  it('rejects an svg over the byte cap', () => {
    const padding = ' '.repeat(PLUGIN_TASK_SOURCE_ICON_MAX_BYTES)
    const result = buildPluginTaskSourceIconDataUrl(
      `<svg xmlns="http://www.w3.org/2000/svg">${padding}</svg>`
    )

    expect(result).toEqual({
      ok: false,
      error: `exceeds the ${PLUGIN_TASK_SOURCE_ICON_MAX_BYTES}-byte icon limit`
    })
  })

  it('rejects a script element', () => {
    const result = buildPluginTaskSourceIconDataUrl(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>fetch("https://evil.test")</script></svg>'
    )

    expect(result).toEqual({ ok: false, error: '<script> is not allowed' })
  })

  it('rejects an on* event handler attribute', () => {
    const result = buildPluginTaskSourceIconDataUrl(
      '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><path d="M0 0h1v1H0z"/></svg>'
    )

    expect(result).toEqual({
      ok: false,
      error: 'event handler attribute "onload" is not allowed'
    })
  })

  it('rejects a foreignObject element', () => {
    const result = buildPluginTaskSourceIconDataUrl(
      '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject width="1" height="1"/></svg>'
    )

    expect(result).toEqual({ ok: false, error: '<foreignObject> is not allowed' })
  })

  it('rejects an href that leaves the document', () => {
    const external = buildPluginTaskSourceIconDataUrl(
      '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://evil.test/pixel.png"/></svg>'
    )
    const legacy = buildPluginTaskSourceIconDataUrl(
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><use xlink:href="http://evil.test/x.svg#g"/></svg>'
    )

    expect(external).toEqual({
      ok: false,
      error: '"href" must reference a local #fragment'
    })
    expect(legacy).toEqual({
      ok: false,
      error: '"xlink:href" must reference a local #fragment'
    })
  })

  it('rejects markup that is not well-formed XML rooted at <svg>', () => {
    expect(buildPluginTaskSourceIconDataUrl('<svg><path d="M0 0"></svg>').ok).toBe(false)
    expect(buildPluginTaskSourceIconDataUrl('<div><svg/></div>').ok).toBe(false)
    expect(buildPluginTaskSourceIconDataUrl('not markup at all').ok).toBe(false)
  })

  it('rejects a doctype, whose entity declarations can expand without limit', () => {
    const result = buildPluginTaskSourceIconDataUrl(
      '<!DOCTYPE svg [<!ENTITY a "aaaa">]><svg xmlns="http://www.w3.org/2000/svg"/>'
    )

    expect(result).toEqual({
      ok: false,
      error: 'doctype and other markup declarations are not allowed'
    })
  })
})
