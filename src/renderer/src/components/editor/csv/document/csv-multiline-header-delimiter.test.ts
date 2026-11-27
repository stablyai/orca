import { expect, it } from 'vitest'
import { detectCsvDelimiter } from './csv-delimiter-detection'

it.each([';', '\t'])(
  'detects %j across quoted line breaks while preserving mid-cell quotes',
  (separator) => {
    const ordinary = `Artikel${separator}Abmessungen "L, B, H"${separator}Preis\r\nBox${separator}10 x 20${separator}42\r\n`
    expect(detectCsvDelimiter('data.csv', ordinary)).toBe(separator)

    const multiline = `\uFEFF"First,\r\nlast"${separator}"Second\r\nheader"${separator}value\r\nx${separator}y${separator}42\r\n`
    expect(detectCsvDelimiter('data.csv', multiline)).toBe(separator)

    // csv-parse.ts keeps text after a closing quote, so these are valid multiline headers.
    // Comma data rows make a record that runs past the header line resolve to `,`.
    const lenientClose = `"Product\nname"${separator}"Weight" (kg)${separator}Price\nA,1,2\nB,3,4\n`
    expect(detectCsvDelimiter('data.csv', lenientClose)).toBe(separator)

    const spaceAfterClose = `"First\nlast" ${separator}b${separator}c\n1,2,3\n4,5,6\n`
    expect(detectCsvDelimiter('data.csv', spaceAfterClose)).toBe(separator)
  }
)
