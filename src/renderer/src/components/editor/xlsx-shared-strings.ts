import { forEachXlsxXmlElement, readXlsxXmlTextRuns } from './xlsx-xml-elements'

// Why: `<rPh>` holds the phonetic reading of a Japanese string (furigana) and
// carries its own `<t>` runs. Excel shows it above the cell, never inside the
// value, so it must be dropped before the runs are concatenated.
const PHONETIC_RUN_PATTERN = /<rPh[\s>][\s\S]*?<\/rPh>/g

/**
 * Parses `xl/sharedStrings.xml` into the index-addressed table that cells with
 * `t="s"` point into.
 */
export function parseXlsxSharedStrings(xml: string): string[] {
  const sharedStrings: string[] = []

  forEachXlsxXmlElement(xml, 'si', (element) => {
    sharedStrings.push(readXlsxXmlTextRuns(element.inner.replace(PHONETIC_RUN_PATTERN, '')))
  })

  return sharedStrings
}
