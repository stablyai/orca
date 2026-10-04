import { gzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { synctexTextFromRead } from './synctex-read-payload'

const SYNCTEX = 'SyncTeX Version:1\nInput:1:/work/main.tex\n'

describe('synctexTextFromRead', () => {
  it('inflates a base64 .synctex.gz reply', async () => {
    const content = gzipSync(SYNCTEX).toString('base64')
    await expect(
      synctexTextFromRead({ content, isBinary: true, mimeType: 'application/gzip' })
    ).resolves.toBe(SYNCTEX)
  })

  it('takes an uncompressed .synctex as text', async () => {
    await expect(synctexTextFromRead({ content: SYNCTEX, isBinary: false })).resolves.toBe(SYNCTEX)
  })

  it('treats an older host’s empty binary reply as no SyncTeX', async () => {
    await expect(synctexTextFromRead({ content: '', isBinary: true })).resolves.toBeNull()
  })

  it('ignores binary content that is not SyncTeX gzip', async () => {
    await expect(
      synctexTextFromRead({ content: 'JVBERi0=', isBinary: true, mimeType: 'application/pdf' })
    ).resolves.toBeNull()
  })
})
