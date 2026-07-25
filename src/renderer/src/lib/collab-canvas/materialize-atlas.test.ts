import { describe, expect, it, vi } from 'vitest'
import { materializeCollabAtlasToTempFile } from './materialize-atlas'

describe('materializeCollabAtlasToTempFile', () => {
  it('returns no-atlas when missing', async () => {
    await expect(materializeCollabAtlasToTempFile(null)).resolves.toEqual({
      ok: false,
      reason: 'no-atlas'
    })
  })

  it('rejects non-image data URIs', async () => {
    await expect(materializeCollabAtlasToTempFile('data:text/plain;base64,YQ==')).resolves.toEqual({
      ok: false,
      reason: 'invalid-data-uri'
    })
  })

  it('writes clipboard image and returns temp path', async () => {
    const writeClipboardImage = vi.fn(async () => {})
    const saveClipboardImageAsTempFile = vi.fn(async () => '/tmp/orca-paste-1.png')
    const result = await materializeCollabAtlasToTempFile('data:image/png;base64,abc=', {
      writeClipboardImage,
      saveClipboardImageAsTempFile
    })
    expect(result).toEqual({ ok: true, filePath: '/tmp/orca-paste-1.png' })
    expect(writeClipboardImage).toHaveBeenCalledWith('data:image/png;base64,abc=')
    expect(saveClipboardImageAsTempFile).toHaveBeenCalled()
  })
})
