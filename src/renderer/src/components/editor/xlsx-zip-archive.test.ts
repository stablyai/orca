import { describe, expect, it } from 'vitest'
import { openXlsxZipArchive } from './xlsx-zip-archive'
import { buildZipArchive } from './xlsx-workbook-test-fixtures'

function centralDirectoryOffset(bytes: Uint8Array): number {
  return new DataView(bytes.buffer).getUint32(bytes.length - 22 + 16, true)
}

describe('openXlsxZipArchive', () => {
  it('reads deflated and stored parts from the same archive', async () => {
    const deflatedText = 'deflate me '.repeat(64)
    const archive = openXlsxZipArchive(
      buildZipArchive([
        { name: 'xl/workbook.xml', content: deflatedText },
        { name: 'xl/stored.xml', content: '<stored/>', stored: true }
      ])
    )

    expect(archive.partNames).toEqual(['xl/workbook.xml', 'xl/stored.xml'])
    expect(await archive.readPartText('xl/workbook.xml')).toBe(deflatedText)
    expect(await archive.readPartText('xl/stored.xml')).toBe('<stored/>')
  })

  it('round-trips payloads that deflate larger than the source', async () => {
    // Why: incompressible data makes zlib emit stored deflate blocks, a distinct
    // code path inside the inflater from the usual huffman-coded output.
    const incompressible = new Uint8Array(2048)
    for (let index = 0; index < incompressible.length; index += 1) {
      incompressible[index] = (index * 97 + 13) % 251
    }
    const archive = openXlsxZipArchive(
      buildZipArchive([{ name: 'xl/media/blob.bin', content: incompressible }])
    )

    expect(await archive.readPartBytes('xl/media/blob.bin')).toEqual(incompressible)
  })

  it('preserves UTF-8 part names and non-ASCII part content', async () => {
    const archive = openXlsxZipArchive(
      buildZipArchive([{ name: 'xl/hojá-cálculo.xml', content: '<t>caña 日本語</t>' }])
    )

    expect(archive.hasPart('xl/hojá-cálculo.xml')).toBe(true)
    expect(await archive.readPartText('xl/hojá-cálculo.xml')).toBe('<t>caña 日本語</t>')
  })

  it('locates the end-of-central-directory record behind an archive comment', async () => {
    const archive = openXlsxZipArchive(
      buildZipArchive([{ name: 'xl/workbook.xml', content: '<workbook/>' }], 'written by a tool')
    )

    expect(await archive.readPartText('xl/workbook.xml')).toBe('<workbook/>')
  })

  it('finds the real record when the comment itself contains its signature', async () => {
    // Why: a backwards scan that stops at the first signature match would land
    // inside the comment. Only the offset whose length accounting reaches the end
    // of the buffer is the real record.
    const decoyBytes = new Uint8Array(30)
    decoyBytes.set([0x50, 0x4b, 0x05, 0x06])
    const decoyComment = new TextDecoder('latin1').decode(decoyBytes)
    const archive = openXlsxZipArchive(
      buildZipArchive([{ name: 'xl/workbook.xml', content: '<workbook/>' }], decoyComment)
    )

    expect(await archive.readPartText('xl/workbook.xml')).toBe('<workbook/>')
  })

  it('skips directory entries so they cannot shadow a part', () => {
    const archive = openXlsxZipArchive(
      buildZipArchive([
        { name: 'xl/', content: '', stored: true },
        { name: 'xl/workbook.xml', content: '<workbook/>' }
      ])
    )

    expect(archive.partNames).toEqual(['xl/workbook.xml'])
    expect(archive.hasPart('xl/')).toBe(false)
  })

  it('returns null for a part the archive does not contain', async () => {
    const archive = openXlsxZipArchive(
      buildZipArchive([{ name: 'xl/workbook.xml', content: '<workbook/>' }])
    )

    expect(archive.hasPart('xl/sharedStrings.xml')).toBe(false)
    expect(await archive.readPartBytes('xl/sharedStrings.xml')).toBeNull()
    expect(await archive.readPartText('xl/sharedStrings.xml')).toBeNull()
  })

  it('rejects a buffer with no end-of-central-directory record', () => {
    expect(() => openXlsxZipArchive(new TextEncoder().encode('not a zip at all'))).toThrow(
      /end-of-central-directory record is missing/
    )
  })

  it('rejects a buffer too short to hold the record', () => {
    expect(() => openXlsxZipArchive(new Uint8Array(8))).toThrow(
      /end-of-central-directory record is missing/
    )
  })

  it('rejects zip64 archives instead of reading a truncated directory', () => {
    const bytes = buildZipArchive([{ name: 'xl/workbook.xml', content: '<workbook/>' }])
    const endOffset = bytes.length - 22
    new DataView(bytes.buffer).setUint16(endOffset + 10, 0xffff, true)

    expect(() => openXlsxZipArchive(bytes)).toThrow(/Zip64/)
  })

  it('rejects a central directory that points past the buffer', () => {
    const bytes = buildZipArchive([{ name: 'xl/workbook.xml', content: '<workbook/>' }])
    const endOffset = bytes.length - 22
    new DataView(bytes.buffer).setUint32(endOffset + 16, bytes.length + 1024, true)

    expect(() => openXlsxZipArchive(bytes)).toThrow(/central directory is truncated/)
  })

  it('rejects a central directory whose entry signature is corrupt', () => {
    const bytes = buildZipArchive([{ name: 'xl/workbook.xml', content: '<workbook/>' }])
    const endOffset = bytes.length - 22
    const directoryOffset = new DataView(bytes.buffer).getUint32(endOffset + 16, true)
    new DataView(bytes.buffer).setUint32(directoryOffset, 0xdeadbeef, true)

    expect(() => openXlsxZipArchive(bytes)).toThrow(/central directory is malformed/)
  })

  it('rejects an entry whose local header is missing', async () => {
    const bytes = buildZipArchive([{ name: 'xl/workbook.xml', content: '<workbook/>' }])
    new DataView(bytes.buffer).setUint32(0, 0xdeadbeef, true)
    const archive = openXlsxZipArchive(bytes)

    await expect(archive.readPartBytes('xl/workbook.xml')).rejects.toThrow(
      /xl\/workbook\.xml has no local file header/
    )
  })

  it('rejects an entry whose payload runs past the end of the buffer', async () => {
    const bytes = buildZipArchive([{ name: 'xl/workbook.xml', content: '<workbook/>' }])
    const endOffset = bytes.length - 22
    const directoryOffset = new DataView(bytes.buffer).getUint32(endOffset + 16, true)
    new DataView(bytes.buffer).setUint32(directoryOffset + 20, bytes.length + 512, true)

    await expect(openXlsxZipArchive(bytes).readPartBytes('xl/workbook.xml')).rejects.toThrow(
      /is truncated/
    )
  })

  it('rejects a compression method it cannot inflate', async () => {
    const bytes = buildZipArchive([{ name: 'xl/workbook.xml', content: '<workbook/>' }])
    const endOffset = bytes.length - 22
    const directoryOffset = new DataView(bytes.buffer).getUint32(endOffset + 16, true)
    // 14 is LZMA: legal ZIP, but nothing Excel writes and nothing we inflate.
    new DataView(bytes.buffer).setUint16(directoryOffset + 10, 14, true)

    await expect(openXlsxZipArchive(bytes).readPartBytes('xl/workbook.xml')).rejects.toThrow(
      /Unsupported compression method 14/
    )
  })

  it('reads sizes from the central directory when a local header is zeroed', async () => {
    // Why: archives written with a streaming data descriptor leave the local
    // header's sizes at zero, so trusting them would return an empty part.
    const bytes = buildZipArchive([{ name: 'xl/workbook.xml', content: '<workbook/>' }])
    const localView = new DataView(bytes.buffer)
    localView.setUint32(18, 0, true)
    localView.setUint32(22, 0, true)

    expect(await openXlsxZipArchive(bytes).readPartText('xl/workbook.xml')).toBe('<workbook/>')
  })

  it('refuses a part that inflates past its declared size', async () => {
    // Why: deflate reaches roughly 1000:1 on crafted input, so a workbook inside
    // the read budget could otherwise expand to gigabytes before any error.
    const bytes = buildZipArchive([{ name: 'xl/sharedStrings.xml', content: 'a'.repeat(8192) }])
    const declaredSizeOffset = centralDirectoryOffset(bytes) + 24
    new DataView(bytes.buffer).setUint32(declaredSizeOffset, 16, true)

    await expect(openXlsxZipArchive(bytes).readPartBytes('xl/sharedStrings.xml')).rejects.toThrow(
      /expands beyond its declared size/
    )
  })

  it('refuses a part whose declared size is past the absolute ceiling', async () => {
    const bytes = buildZipArchive([{ name: 'xl/sheet.xml', content: 'a'.repeat(64) }])
    const declaredSizeOffset = centralDirectoryOffset(bytes) + 24
    new DataView(bytes.buffer).setUint32(declaredSizeOffset, 300 * 1024 * 1024, true)

    await expect(openXlsxZipArchive(bytes).readPartBytes('xl/sheet.xml')).rejects.toThrow(
      /is too large to read/
    )
  })

  it('still reads a part whose declared size is zero, as streaming archivers write', async () => {
    const bytes = buildZipArchive([{ name: 'xl/sheet.xml', content: '<worksheet/>' }])
    new DataView(bytes.buffer).setUint32(centralDirectoryOffset(bytes) + 24, 0, true)

    expect(await openXlsxZipArchive(bytes).readPartText('xl/sheet.xml')).toBe('<worksheet/>')
  })

  it('reads an archive stored at a non-zero byte offset in its buffer', async () => {
    // Why: base64 decoding can hand back a view into a larger buffer, and every
    // offset in the zip is relative to the archive, not the buffer.
    const zip = buildZipArchive([{ name: 'xl/workbook.xml', content: '<workbook/>' }])
    const padded = new Uint8Array(zip.length + 7)
    padded.set(zip, 7)

    const archive = openXlsxZipArchive(padded.subarray(7))
    expect(await archive.readPartText('xl/workbook.xml')).toBe('<workbook/>')
  })
})
