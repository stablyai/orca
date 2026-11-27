import { expect, it } from 'vitest'
import { detectCsvDelimiter } from './csv-delimiter-detection'

it.each([';', '\t'])(
  'detects %j across quoted line breaks while preserving mid-cell quotes',
  (separator) => {
    const ordinary = `Artikel${separator}Abmessungen "L, B, H"${separator}Preis\r\nBox${separator}10 x 20${separator}42\r\n`
    expect(detectCsvDelimiter('data.csv', ordinary)).toBe(separator)

    const multiline = `\uFEFF"First,\r\nlast"${separator}"Second\r\nheader"${separator}value\r\nx${separator}y${separator}42\r\n`
    expect(detectCsvDelimiter('data.csv', multiline)).toBe(separator)
  }
)
