import type { ElectronApplication } from '@stablyai/playwright-test'

export async function captureSystemImageClipboard(app: ElectronApplication) {
  return app.evaluateHandle(({ clipboard, nativeImage }) => {
    const originalFormats = clipboard.availableFormats()
    if (originalFormats.some((format) => format !== 'text/plain')) {
      throw new Error('System clipboard test requires an empty or plain-text clipboard.')
    }
    const originalText = clipboard.readText()
    const signature = () =>
      JSON.stringify({
        formats: clipboard.availableFormats().sort(),
        text: clipboard.readText(),
        html: clipboard.readHTML(),
        image: clipboard.readImage().toPNG().toString('base64')
      })
    let owned = signature()
    const originalReadBuffer = clipboard.readBuffer
    let bufferReads = 0
    clipboard.readBuffer = (...args) => {
      bufferReads++
      return originalReadBuffer(...args)
    }
    const image = nativeImage.createFromBitmap(
      Buffer.from([0, 0, 255, 255, 0, 255, 0, 255, 255, 0, 0, 255, 0, 0, 0, 0]),
      { width: 2, height: 2 }
    )
    return {
      bufferReads: () => bufferReads,
      assertUnchanged() {
        if (signature() !== owned) {
          throw new Error('Clipboard changed outside this test; leaving it untouched.')
        }
      },
      adoptExternalImage(expectedPng: string) {
        const before = signature()
        const actual = clipboard.readImage()
        const expected = nativeImage.createFromBuffer(Buffer.from(expectedPng, 'base64'))
        const size = actual.getSize()
        if (
          expected.isEmpty() ||
          actual.isEmpty() ||
          size.width !== expected.getSize().width ||
          size.height !== expected.getSize().height ||
          !actual.toBitmap().equals(expected.toBitmap())
        ) {
          throw new Error('External clipboard pixels do not match the test image.')
        }
        const snapshot = {
          formats: clipboard.availableFormats(),
          text: clipboard.readText(),
          html: clipboard.readHTML(),
          png: actual.toPNG().toString('base64')
        }
        if (signature() !== before) {
          throw new Error('Clipboard changed during capture; leaving it untouched.')
        }
        owned = before
        return snapshot
      },
      write(kind: 'mixed' | 'html' | 'text' | 'empty') {
        if (signature() !== owned) {
          throw new Error('Clipboard changed outside this test; leaving it untouched.')
        }
        const text =
          kind === 'mixed' ? 'clipboard-paste-marker' : 'https://example.invalid/image.png'
        if (kind === 'empty') {
          clipboard.clear()
        } else if (kind === 'text') {
          clipboard.writeText(text)
        } else {
          clipboard.write({
            text,
            html: '<img src="https://example.invalid/image.png">',
            ...(kind === 'mixed' ? { image } : {})
          })
        }
        owned = signature()
        return {
          formats: clipboard.availableFormats(),
          text: clipboard.readText(),
          html: clipboard.readHTML(),
          png: clipboard.readImage().toPNG().toString('base64')
        }
      },
      restore() {
        clipboard.readBuffer = originalReadBuffer
        if (signature() !== owned) {
          return false
        }
        if (originalFormats.length === 0) {
          clipboard.clear()
        } else {
          clipboard.writeText(originalText)
        }
        return true
      }
    }
  })
}
