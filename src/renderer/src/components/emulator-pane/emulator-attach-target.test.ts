import { describe, expect, it, vi } from 'vitest'
import { attachWithAvdFallback } from './emulator-attach-target'

const rows = [{ udid: 'emulator-5554', name: 'Pixel_9', state: 'Booted', runtime: 'emulator' }]

function hostError(code: string): Error {
  return Object.assign(new Error('host error'), { code })
}

describe('attachWithAvdFallback', () => {
  it('reboots a vanished emulator by its AVD name only when the host no longer finds its serial', async () => {
    const onRetarget = vi.fn()
    const attachTo = vi.fn(async (device?: string) => {
      if (device === 'emulator-5554') {
        throw hostError('emulator_device_not_found')
      }
      return { attached: device === 'Pixel_9' }
    })
    await expect(
      attachWithAvdFallback(rows, 'emulator-5554', onRetarget, attachTo)
    ).resolves.toEqual({ attached: true })
    expect(onRetarget).toHaveBeenCalledWith('Pixel_9')

    const failing = vi.fn(async () => {
      throw hostError('emulator_error')
    })
    await expect(attachWithAvdFallback(rows, 'emulator-5554', onRetarget, failing)).rejects.toThrow(
      'host error'
    )
    expect(failing).toHaveBeenCalledTimes(1)
  })
})

it.each(['missing', 'unavailable'] as const)(
  'recovers a missing AVD serial without overriding an unavailable-device refusal (%s)',
  async (selectionRequired) => {
    const onRetarget = vi.fn()
    const attachTo = vi.fn(async (device?: string) =>
      device === 'Pixel_9' ? { attached: true } : { attached: false, selectionRequired }
    )
    await expect(
      attachWithAvdFallback(rows, 'emulator-5554', onRetarget, attachTo)
    ).resolves.toEqual(
      selectionRequired === 'missing' ? { attached: true } : { attached: false, selectionRequired }
    )
    expect(onRetarget.mock.calls).toEqual(selectionRequired === 'missing' ? [['Pixel_9']] : [])
  }
)
