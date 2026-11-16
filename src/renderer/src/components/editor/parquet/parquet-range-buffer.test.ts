import { describe, expect, it } from 'vitest'
import { createParquetRangeBuffer } from './parquet-range-buffer'

const FILE_BYTES = 600 * 1024

function fileByte(offset: number): number {
  return (offset * 31 + 7) % 251
}

function fakeFile() {
  const lengths: number[] = []
  const read = async (offset: number, length: number): Promise<Uint8Array> => {
    lengths.push(length)
    return Uint8Array.from({ length: Math.min(length, FILE_BYTES - offset) }, (_, i) =>
      fileByte(offset + i)
    )
  }
  return { lengths, read }
}

describe('Parquet range buffer', () => {
  it('stitches a slice larger than one host range read from capped reads', async () => {
    const file = fakeFile()
    const buffer = createParquetRangeBuffer(FILE_BYTES, file.read)
    const bytes = new Uint8Array(await buffer.slice(1000, 1000 + 300 * 1024))
    expect(file.lengths).toEqual([262144, 45056])
    expect(bytes.length).toBe(307200)
    expect([bytes[0], bytes[262143], bytes[262144], bytes[307199]]).toEqual([
      fileByte(1000),
      fileByte(263143),
      fileByte(263144),
      fileByte(308199)
    ])
  })

  it('reads the footer suffix once when hyparquet asks for it again', async () => {
    const file = fakeFile()
    const buffer = createParquetRangeBuffer(FILE_BYTES, file.read)
    await buffer.slice(-8)
    await buffer.slice(FILE_BYTES - 8, FILE_BYTES)
    expect(file.lengths).toEqual([8])
  })

  it('rejects a short read instead of returning zero-filled bytes', async () => {
    const buffer = createParquetRangeBuffer(FILE_BYTES + 10, fakeFile().read)
    await expect(buffer.slice(FILE_BYTES - 10, FILE_BYTES + 10)).rejects.toThrow(
      'Parquet file changed'
    )
  })
})
