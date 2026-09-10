import { beforeEach, describe, expect, it, vi } from 'vitest'
import { canvasToPngDataUrl } from '@/lib/canvas-png-data-url'
import { saveEmulatorScreenshot } from './save-emulator-screenshot'

vi.mock('@/lib/canvas-png-data-url', () => ({
  canvasToPngDataUrl: vi.fn()
}))

const encode = vi.mocked(canvasToPngDataUrl)
const saveDownloadedFile = vi.fn()
const canvas = {} as HTMLCanvasElement
const now = new Date('2026-01-02T03:04:05.006Z')

beforeEach(() => {
  encode.mockReset()
  saveDownloadedFile.mockReset()
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { api: { fs: { saveDownloadedFile } } }
  })
})

describe('saveEmulatorScreenshot', () => {
  it('strips the PNG data URL prefix and uses a portable filename', async () => {
    encode.mockResolvedValue('data:image/png;base64,AAE=')
    saveDownloadedFile.mockResolvedValue({ canceled: false, destinationPath: '/tmp/screen.png' })

    await expect(saveEmulatorScreenshot(canvas, now)).resolves.toEqual({
      canceled: false,
      destinationPath: '/tmp/screen.png'
    })
    expect(saveDownloadedFile).toHaveBeenCalledWith({
      suggestedName: 'emulator-screenshot-2026-01-02T03-04-05-006Z.png',
      content: 'AAE=',
      encoding: 'base64'
    })
  })

  it('passes native dialog cancellation through without writing content', async () => {
    encode.mockResolvedValue('data:image/png;base64,AAE=')
    saveDownloadedFile.mockResolvedValue({ canceled: true })

    await expect(saveEmulatorScreenshot(canvas, now)).resolves.toEqual({ canceled: true })
  })

  it('rejects non-PNG encodings', async () => {
    encode.mockResolvedValue('data:image/jpeg;base64,AAE=')

    await expect(saveEmulatorScreenshot(canvas, now)).rejects.toThrow('PNG')
    expect(saveDownloadedFile).not.toHaveBeenCalled()
  })
})
