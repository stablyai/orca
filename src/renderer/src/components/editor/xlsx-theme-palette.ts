import { forEachXlsxXmlElement } from './xlsx-xml-elements'

/** Theme colours in the order a `theme="N"` attribute indexes them. */
export type XlsxThemePalette = readonly (string | undefined)[]

// Why: a `<color theme="N">` index does NOT follow `<a:clrScheme>` document
// order. The first two pairs are swapped — index 0 is lt1 and index 1 is dk1,
// index 2 is lt2 and index 3 is dk2 — because the scheme lists them as
// background/text pairs while the index refers to them the other way round.
// Getting this wrong silently swaps black and white on every themed cell.
const THEME_COLOR_ELEMENT_ORDER = [
  'a:lt1',
  'a:dk1',
  'a:lt2',
  'a:dk2',
  'a:accent1',
  'a:accent2',
  'a:accent3',
  'a:accent4',
  'a:accent5',
  'a:accent6',
  'a:hlink',
  'a:folHlink'
] as const

const SYSTEM_COLOR_VALUES: Record<string, string> = {
  window: 'FFFFFF',
  windowText: '000000'
}

/**
 * Reads `xl/theme/theme1.xml` into the palette that themed colours resolve
 * against. An absent or unreadable theme yields an empty palette, which makes
 * themed colours resolve to nothing rather than to a wrong colour.
 */
export function parseXlsxThemePalette(themeXml: string): XlsxThemePalette {
  let colorSchemeXml = ''
  forEachXlsxXmlElement(themeXml, 'a:clrScheme', (element) => {
    colorSchemeXml = element.inner
    return false
  })
  if (colorSchemeXml === '') {
    return []
  }

  return THEME_COLOR_ELEMENT_ORDER.map((elementName) =>
    readSchemeColor(colorSchemeXml, elementName)
  )
}

function readSchemeColor(colorSchemeXml: string, elementName: string): string | undefined {
  let color: string | undefined
  forEachXlsxXmlElement(colorSchemeXml, elementName, (element) => {
    forEachXlsxXmlElement(element.inner, 'a:srgbClr', (srgb) => {
      color = srgb.attributes.val
      return false
    })
    if (color === undefined) {
      // Why: a scheme slot may reference a system colour instead of an explicit
      // one, most often for the two neutral slots.
      forEachXlsxXmlElement(element.inner, 'a:sysClr', (system) => {
        color = system.attributes.lastClr ?? SYSTEM_COLOR_VALUES[system.attributes.val ?? '']
        return false
      })
    }
    return false
  })
  return color
}
