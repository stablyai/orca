import { decodeXlsxXmlText, forEachXlsxXmlElement } from './xlsx-xml-elements'

// Why: a chart with thousands of points is a rendering cost with no readable
// payoff at the size a spreadsheet anchors it. The caches are bounded here
// because this is where they are read.
export const MAX_CHART_CATEGORIES = 500

// Why: the chart parts are read with the same forward-only scanner as the rest of
// the workbook. These are the low-level readers every chart module shares, kept
// apart so the series reader and the chart assembler cannot drift over them.

export function readElementText(xml: string, tagName: string): string | undefined {
  let text: string | undefined
  forEachXlsxXmlElement(xml, tagName, (element) => {
    text = decodeXlsxXmlText(element.inner).trim()
    return false
  })
  return text
}

/** Reads `<c:pt idx>` string values, placed by index rather than document order. */
export function readStringCache(xml: string): string[] {
  const values: string[] = []
  forEachXlsxXmlElement(xml, 'c:pt', (element) => {
    const index = Number.parseInt(element.attributes.idx ?? '', 10)
    if (!Number.isInteger(index) || index < 0 || index >= MAX_CHART_CATEGORIES) {
      return true
    }
    while (values.length < index) {
      values.push('')
    }
    values[index] = readFirstValue(element.inner) ?? ''
    return true
  })
  return values
}

export function readNumericCache(xml: string): (number | null)[] {
  const values: (number | null)[] = []
  forEachXlsxXmlElement(xml, 'c:pt', (element) => {
    const index = Number.parseInt(element.attributes.idx ?? '', 10)
    if (!Number.isInteger(index) || index < 0 || index >= MAX_CHART_CATEGORIES) {
      return true
    }
    while (values.length < index) {
      values.push(null)
    }
    const parsed = Number(readFirstValue(element.inner) ?? '')
    values[index] = Number.isFinite(parsed) ? parsed : null
    return true
  })
  return values
}

export function readFirstValue(xml: string): string | undefined {
  let value: string | undefined
  forEachXlsxXmlElement(xml, 'c:v', (element) => {
    value = decodeXlsxXmlText(element.inner).trim()
    return false
  })
  return value
}

export function readElementInner(xml: string, tagName: string): string | null {
  let inner: string | null = null
  forEachXlsxXmlElement(xml, tagName, (element) => {
    inner = element.inner
    return false
  })
  return inner
}

export function readAttributeValue(xml: string, tagName: string): string | undefined {
  let value: string | undefined
  forEachXlsxXmlElement(xml, tagName, (element) => {
    value = element.attributes.val
    return false
  })
  return value
}

export function hasElement(xml: string, tagName: string): boolean {
  return countElements(xml, tagName) > 0
}

export function countElements(xml: string, tagName: string): number {
  let count = 0
  forEachXlsxXmlElement(xml, tagName, () => {
    count += 1
  })
  return count
}
