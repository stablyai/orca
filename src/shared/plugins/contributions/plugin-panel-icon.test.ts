import { describe, expect, it } from 'vitest'
import {
  PLUGIN_PANEL_ICON_FILE_MAX_BYTES,
  pluginPanelIconFileError,
  pluginPanelIconKind,
  pluginPanelIconSchema,
  pluginPanelIconSvgError
} from './plugin-panel-icon'

const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M1 1h22v22H1z" fill="currentColor"/></svg>'

describe('plugin panel icons', () => {
  it.each([
    ['database', 'builtin'],
    ['icons/panel.svg', 'file']
  ])('classifies %s as %s', (value, kind) => {
    expect(pluginPanelIconKind(value)).toBe(kind)
    expect(pluginPanelIconSchema.safeParse(value).success).toBe(true)
  })

  it('canonicalizes the older camel-case spelling before a format 1 manifest is parsed', () => {
    expect(pluginPanelIconKind('FileText')).toBe('builtin')
  })

  it.each([
    'mail',
    '1',
    '../panel.svg',
    '/assets/panel.svg',
    'https://evil.example/panel.svg',
    'icons/panel.txt',
    'icons/panel.svg?raw=1'
  ])('refuses %s', (value) => {
    expect(pluginPanelIconKind(value)).toBeNull()
    expect(pluginPanelIconSchema.safeParse(value).success).toBe(false)
  })
})

describe('plugin panel icon files', () => {
  it('accepts a strict XML declaration', () => {
    expect(
      pluginPanelIconSvgError(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${SVG}`)
    ).toBeNull()
    expect(pluginPanelIconSvgError(`<?xml version="1.1"?>${SVG}`)).toBeNull()
  })

  it('accepts fills and strokes that are only currentColor or none', () => {
    expect(
      pluginPanelIconSvgError(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"><path d="M1 1h22v22H1z" fill="none" stroke="currentColor"/><g fill="currentColor"><rect width="4" height="4"/></g></svg>'
      )
    ).toBeNull()
  })

  it('checks SVG structure and bytes', () => {
    expect(pluginPanelIconFileError('icons/panel.svg', Buffer.from(SVG))).toBeNull()
    expect(
      pluginPanelIconFileError(
        'icons/panel.svg',
        Buffer.concat([Buffer.from(SVG), Buffer.alloc(PLUGIN_PANEL_ICON_FILE_MAX_BYTES)])
      )
    ).toMatch(/32 KB/)
  })

  it.each([
    [
      'a missing viewBox',
      '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h1v1z"/></svg>',
      /viewBox/
    ],
    [
      'a script',
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><script>alert(1)</script></svg>',
      /script/
    ],
    [
      'an event handler',
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect onclick="x()"/></svg>',
      /onclick/
    ],
    [
      'an external paint server',
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect fill="url(https://evil/x.svg#a)"/></svg>',
      /attribute/
    ],
    [
      'a protocol-relative external URL',
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect style="fill:image-set(//evil/x.svg)"/></svg>',
      /attribute/
    ],
    [
      'foreign content',
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><foreignObject/></svg>',
      /foreignObject/
    ],
    [
      'a document type',
      '<!DOCTYPE svg><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>',
      /document types/
    ],
    [
      'mis-ordered elements',
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><g><path/></svg>',
      /closed in order/
    ],
    [
      'content after the root',
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/><script>alert(1)</script>',
      /one complete SVG/
    ],
    [
      'an encoded external URL',
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect fill="url(&#104;ttps://evil/x.svg#a)"/></svg>',
      /attribute/
    ],
    [
      'an encoded script URL',
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect fill="&#106;avascript:alert(1)"/></svg>',
      /attribute/
    ],
    [
      'an unknown entity',
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect fill="&external;"/></svg>',
      /attribute/
    ],
    [
      'an XML-encoded CSS escape',
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect style="fill:u&#92;72l(&#92;68ttps:&#92;2f&#92;2f example.com/a.svg#p)"/></svg>',
      /attribute/
    ],
    [
      'an XML stylesheet processing instruction',
      '<?xml-stylesheet type="text/css" href="https://example.invalid/x.css"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>',
      /processing instructions/
    ],
    [
      'a non-UTF-8 encoding',
      '<?xml version="1.0" encoding="ISO-8859-1"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>',
      /UTF-8/
    ],
    [
      'an XML declaration that is not version 1.x',
      '<?xml version="2.0"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>',
      /XML declarations/
    ],
    [
      'a multi-colour paint',
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1" fill="currentColor"/><rect width="1" height="1" fill="#ff0000"/></svg>',
      /monochrome/
    ],
    [
      'an implicit black fill',
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><path d="M0 0h1v1z" stroke="currentColor"/></svg>',
      /monochrome/
    ]
  ])('refuses %s', (_label, svg, error) => {
    expect(pluginPanelIconSvgError(svg)).toMatch(error)
  })

  it('rejects a stray tag start without rescanning the whole document', () => {
    expect(pluginPanelIconSvgError('<a'.repeat(16 * 1024))).toMatch(/malformed|one SVG/)
  })
})
