import { expect, it } from 'vitest'
import { detectCsvDelimiter } from './csv-delimiter-detection'
import { parseCsv } from './csv-parse'

it.each([';', '\t'])('detects %j after a multiline quoted first header', (separator) => {
  const content = `\uFEFF"First,\r\nlast"${separator}value\r\n"A,\r\nB"${separator}42\r\n`
  const delimiter = detectCsvDelimiter('data.csv', content)

  expect(delimiter).toBe(separator)
  expect(parseCsv(content, delimiter).rows).toEqual([
    ['First,\r\nlast', 'value'],
    ['A,\r\nB', '42']
  ])
})
