import { describe, expect, it } from 'vitest'
import {
  getProcessOutputFields,
  iterateProcessOutputLines,
  PROCESS_OUTPUT_FIELD_SCAN_MAX_CHARS
} from './process-output-field-scanner'

describe('iterateProcessOutputLines', () => {
  it('walks LF, CRLF, and CR lines without returning a trailing synthetic line', () => {
    expect([...iterateProcessOutputLines('alpha\nbeta\r\ngamma\rdelta\n')]).toEqual([
      'alpha',
      'beta',
      'gamma',
      'delta'
    ])
  })
})

describe('getProcessOutputFields', () => {
  it('returns bounded whitespace-separated fields', () => {
    expect(
      getProcessOutputFields('  TCP\t127.0.0.1:3000   0.0.0.0:0 LISTENING 4242 extra', 5)
    ).toEqual(['TCP', '127.0.0.1:3000', '0.0.0.0:0', 'LISTENING', '4242'])
  })

  it('caps scan work for oversized rows', () => {
    const fields = getProcessOutputFields('x'.repeat(PROCESS_OUTPUT_FIELD_SCAN_MAX_CHARS + 100), 2)

    expect(fields).toEqual(['x'.repeat(PROCESS_OUTPUT_FIELD_SCAN_MAX_CHARS)])
  })

  it('keeps a field that ends exactly at the scan boundary', () => {
    const boundaryField = 'x'.repeat(PROCESS_OUTPUT_FIELD_SCAN_MAX_CHARS)

    expect(getProcessOutputFields(boundaryField, 1)).toEqual([boundaryField])
  })
})
