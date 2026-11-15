import { describe, expect, it } from 'vitest'
import {
  PLUGIN_PANEL_ICON_FILE_MAX_BYTES,
  pluginPanelIconFileError,
  pluginPanelIconKind,
  pluginPanelIconSchema,
  pluginPanelIconSvgError
} from './plugin-panel-icon'

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
)
const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M1 1h22v22H1z" fill="currentColor"/></svg>'

describe('plugin panel icons', () => {
  it.each([
    ['database', 'builtin'],
    ['🧩', 'emoji'],
    ['👩🏽‍💻', 'emoji'],
    ['icons/panel.svg', 'file'],
    ['icons/panel.PNG', 'file']
  ])('classifies %s as %s', (value, kind) => {
    expect(pluginPanelIconKind(value)).toBe(kind)
    expect(pluginPanelIconSchema.safeParse(value).success).toBe(true)
  })

  it('canonicalizes the older camel-case spelling before a format 1 manifest is parsed', () => {
    expect(pluginPanelIconKind('FileText')).toBe('builtin')
  })

  it.each([
    'mail',
    '🧩🧩',
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
  it('checks SVG structure and PNG bytes', () => {
    expect(pluginPanelIconFileError('icons/panel.svg', Buffer.from(SVG))).toBeNull()
    expect(pluginPanelIconFileError('icons/panel.png', PNG)).toBeNull()
    expect(pluginPanelIconFileError('icons/panel.png', Buffer.from(SVG))).toMatch(/PNG/)
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
    ]
  ])('refuses %s', (_label, svg, error) => {
    expect(pluginPanelIconSvgError(svg)).toMatch(error)
  })
})
