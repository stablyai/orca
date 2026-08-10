import { forEachXlsxXmlElement, readXlsxXmlTextRuns } from './xlsx-xml-elements'

/**
 * Parses `xl/sharedStrings.xml` into the index-addressed table that cells with
 * `t="s"` point into.
 *
 * Phonetic runs are dropped by `readXlsxXmlTextRuns`, so a shared string and an
 * inline string holding the same value read identically.
 */
export function parseXlsxSharedStrings(xml: string): string[] {
  const sharedStrings: string[] = []

  forEachXlsxXmlElement(xml, 'si', (element) => {
    sharedStrings.push(readXlsxXmlTextRuns(element.inner))
  })

  return sharedStrings
}
