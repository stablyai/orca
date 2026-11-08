import { expect, it } from 'vitest'
import { pasteTextIntoAndroidEmulator } from './emulator-keyboard-paste'

it('accepts Unicode for Android clipboard injection and normalizes line endings', async () => {
  await expect(
    pasteTextIntoAndroidEmulator({
      text: '你好\r\nOrca',
      sendText: async (text) => text === '你好\nOrca'
    })
  ).resolves.toEqual({ byteLength: 12, chunkCount: 1, status: 'sent' })
})
