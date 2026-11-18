import { describe, expect, it } from 'vitest'
import { parquetCellText } from './parquet-cell-text'

describe('Parquet cell text', () => {
  it('shows printable UTF-8 bytes as text and other bytes as hex', () => {
    expect(parquetCellText(new TextEncoder().encode('zone-07 ✓'))).toBe('zone-07 ✓')
    expect(parquetCellText(new Uint8Array([0xff, 0x00]))).toBe('0xff00')
    expect(parquetCellText(new Uint8Array([0x61, 0x00, 0x62]))).toBe('0x610062')
    expect(parquetCellText({ id: 7n, raw: new Uint8Array([0xff, 0xfe]) })).toBe(
      '{"id":"7","raw":"0xfffe"}'
    )
  })
})
