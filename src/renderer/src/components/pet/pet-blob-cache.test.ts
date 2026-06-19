import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  blobUrlCache,
  detectedSpriteCache,
  loadCustomBlobUrl,
  revokeCustomPetBlobUrl
} from './pet-blob-cache'

const TEST_PET_IDS = ['pet', 'late-pet', 'bundle-pet']

afterEach(() => {
  for (const id of TEST_PET_IDS) {
    revokeCustomPetBlobUrl(id)
  }
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function stubPetRead(read: ReturnType<typeof vi.fn>): void {
  vi.stubGlobal('window', {
    api: {
      pet: { read }
    }
  })
}

describe('loadCustomBlobUrl', () => {
  it('coalesces concurrent loads for the same custom pet', async () => {
    const read = vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]).buffer)
    stubPetRead(read)
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:pet')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})

    const first = loadCustomBlobUrl('pet', 'pet.png', 'image/png')
    const second = loadCustomBlobUrl('pet', 'pet.png', 'image/png')

    await expect(Promise.all([first, second])).resolves.toEqual(['blob:pet', 'blob:pet'])
    expect(read).toHaveBeenCalledTimes(1)
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1)
    expect(blobUrlCache.get('pet')).toBe('blob:pet')
  })

  it('revokes a blob URL created after the custom pet was removed', async () => {
    let resolveRead: (buffer: ArrayBuffer) => void = () => {}
    const read = vi.fn(
      () =>
        new Promise<ArrayBuffer>((resolve) => {
          resolveRead = resolve
        })
    )
    stubPetRead(read)
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:late-pet')
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})

    const load = loadCustomBlobUrl('late-pet', 'pet.png', 'image/png')
    revokeCustomPetBlobUrl('late-pet')
    resolveRead(new Uint8Array([4, 5, 6]).buffer)

    await expect(load).resolves.toBeNull()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:late-pet')
    expect(blobUrlCache.has('late-pet')).toBe(false)
  })

  it('closes detected sprite bitmaps when bundle processing cannot emit a keyed blob', async () => {
    const read = vi.fn().mockResolvedValue(new Uint8Array([7, 8, 9]).buffer)
    stubPetRead(read)
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:bundle-input')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})

    const bitmap = { close: vi.fn() } as unknown as ImageBitmap
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue(bitmap))
    vi.stubGlobal(
      'Image',
      class {
        naturalWidth = 8
        naturalHeight = 8
        onload: (() => void) | null = null
        set src(_value: string) {
          queueMicrotask(() => this.onload?.())
        }
      }
    )

    const pixels = new Uint8ClampedArray(8 * 8 * 4)
    for (let i = 0; i < pixels.length; i += 4) {
      pixels[i + 3] = 255
    }
    const imageData = { data: pixels, width: 8, height: 8 } as ImageData
    const canvas = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => ({
        drawImage: vi.fn(),
        getImageData: vi.fn(() => imageData),
        putImageData: vi.fn()
      })),
      toBlob: vi.fn((callback: BlobCallback) => callback(null))
    } as unknown as HTMLCanvasElement
    vi.stubGlobal('document', { createElement: vi.fn(() => canvas) })

    await expect(loadCustomBlobUrl('bundle-pet', 'pet.png', 'image/png', 'bundle')).resolves.toBe(
      'blob:bundle-input'
    )
    expect(bitmap.close).toHaveBeenCalledTimes(1)
    expect(detectedSpriteCache.has('bundle-pet')).toBe(false)
  })
})
