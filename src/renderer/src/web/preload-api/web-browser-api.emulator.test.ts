// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'
import { createEmulatorApi } from './web-browser-api'
import { withFallback } from './web-fallback-api'

describe('web emulator API', () => {
  it.each([
    {
      platform: 'iOS AVCC',
      args: {
        deviceId: 'ios-device',
        streamId: 'ios-stream',
        avccStreamUrl: 'http://127.0.0.1:3100/stream.avcc'
      }
    },
    {
      platform: 'Android Annex-B',
      args: { deviceId: 'android-device', streamId: 'android-stream' }
    }
  ])(
    'rejects unsupported $platform video starts instead of resolving a fallback result',
    async ({ args }) => {
      const emulator = withFallback(createEmulatorApi(), ['emulator'])

      await expect(emulator.startVideoStream(args)).rejects.toThrow(
        'Mobile emulator is unavailable on web.'
      )
    }
  )

  it('refuses Android input instead of reporting a fallback acknowledgement', async () => {
    const emulator = withFallback(createEmulatorApi(), ['emulator'])

    expect(() =>
      emulator.sendScrcpyTouch({ deviceId: 'android-device', type: 'begin', x: 0.5, y: 0.5 })
    ).toThrow('Mobile emulator is unavailable on web.')
    await expect(
      emulator.sendScrcpyKeyboard({ deviceId: 'android-device', text: 'hello' })
    ).rejects.toThrow('Mobile emulator is unavailable on web.')
    await expect(
      emulator.sendScrcpyKeyboard({ deviceId: 'android-device', key: 'enter', shift: false })
    ).rejects.toThrow('Mobile emulator is unavailable on web.')
  })
})
