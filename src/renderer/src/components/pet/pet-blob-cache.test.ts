import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  blobUrlCache,
  CUSTOM_PET_BLOB_CACHE_MAX,
  CUSTOM_PET_MEDIA_CACHE_MAX_BYTES,
  detectedSpriteCache,
  inspectCustomPetMediaCache,
  loadCustomBlobUrl,
  retainCustomPetBlobCacheEntry,
  revokeCustomPetBlobUrl
} from './pet-blob-cache'
import { MAX_CUSTOM_PET_SHEET_PIXELS } from '../../../../shared/custom-pet-media-limits'

const TEST_PET_IDS = ['pet', 'late-pet', 'bundle-pet']

afterEach(() => {
  const ids = new Set([...TEST_PET_IDS, ...blobUrlCache.keys(), ...detectedSpriteCache.keys()])
  for (const id of ids) {
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

  it('does not create a blob URL after the custom pet was removed', async () => {
    let resolveRead: (buffer: ArrayBuffer) => void = () => {}
    const read = vi.fn(
      () =>
        new Promise<ArrayBuffer>((resolve) => {
          resolveRead = resolve
        })
    )
    stubPetRead(read)
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:late-pet')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})

    const load = loadCustomBlobUrl('late-pet', 'pet.png', 'image/png')
    revokeCustomPetBlobUrl('late-pet')
    resolveRead(new Uint8Array([4, 5, 6]).buffer)

    await expect(load).resolves.toBeNull()
    expect(URL.createObjectURL).not.toHaveBeenCalled()
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

  it('counts retained detected bitmaps alongside the processed blob', async () => {
    stubPetRead(vi.fn().mockResolvedValue(new Uint8Array([7, 8, 9]).buffer))
    vi.spyOn(URL, 'createObjectURL')
      .mockReturnValueOnce('blob:bundle-input')
      .mockReturnValueOnce('blob:bundle-output')
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
    for (let index = 3; index < pixels.length; index += 4) {
      pixels[index] = 255
    }
    const output = new Blob([new Uint8Array(10)])
    const canvas = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => ({
        drawImage: vi.fn(),
        getImageData: vi.fn(() => ({ data: pixels, width: 8, height: 8 }) as ImageData),
        putImageData: vi.fn()
      })),
      toBlob: vi.fn((callback: BlobCallback) => callback(output))
    } as unknown as HTMLCanvasElement
    vi.stubGlobal('document', { createElement: vi.fn(() => canvas) })

    await expect(
      loadCustomBlobUrl('bundle-counted', 'sheet.png', 'image/png', 'bundle')
    ).resolves.toBe('blob:bundle-output')

    expect(inspectCustomPetMediaCache().retainedBytes).toBe(output.size + 8 * 8 * 4)
    expect(detectedSpriteCache.get('bundle-counted')?.bitmaps).toEqual([bitmap])
  })

  it('evicts least-recent custom pet blobs and closes detected sprite bitmaps', async () => {
    const read = vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]).buffer)
    stubPetRead(read)
    let blobIndex = 0
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:pet-${blobIndex++}`)
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const evictedBitmap = { close: vi.fn() } as unknown as ImageBitmap

    for (let index = 0; index < CUSTOM_PET_BLOB_CACHE_MAX; index += 1) {
      await expect(loadCustomBlobUrl(`pet-${index}`, 'pet.png', 'image/png')).resolves.toBe(
        `blob:pet-${index}`
      )
    }
    detectedSpriteCache.set('pet-1', {
      bitmaps: [evictedBitmap],
      fps: 8,
      frames: []
    })

    await expect(loadCustomBlobUrl('pet-0', 'pet.png', 'image/png')).resolves.toBe('blob:pet-0')
    await expect(
      loadCustomBlobUrl(`pet-${CUSTOM_PET_BLOB_CACHE_MAX}`, 'pet.png', 'image/png')
    ).resolves.toBe(`blob:pet-${CUSTOM_PET_BLOB_CACHE_MAX}`)

    expect(blobUrlCache.has('pet-0')).toBe(true)
    expect(blobUrlCache.has('pet-1')).toBe(false)
    expect(detectedSpriteCache.has('pet-1')).toBe(false)
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:pet-1')
    expect(evictedBitmap.close).toHaveBeenCalledTimes(1)
  })

  it('evicts by aggregate encoded bytes before the entry-count cap', async () => {
    const entryBytes = Math.floor(CUSTOM_PET_MEDIA_CACHE_MAX_BYTES / 2) + 1
    class SizedBlob {
      size = entryBytes
    }
    vi.stubGlobal('Blob', SizedBlob)
    stubPetRead(vi.fn().mockResolvedValue(new Uint8Array([1]).buffer))
    vi.spyOn(URL, 'createObjectURL')
      .mockReturnValueOnce('blob:large-0')
      .mockReturnValueOnce('blob:large-1')
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})

    await expect(loadCustomBlobUrl('large-0', 'pet.png', 'image/png')).resolves.toBe('blob:large-0')
    await expect(loadCustomBlobUrl('large-1', 'pet.png', 'image/png')).resolves.toBe('blob:large-1')

    expect(blobUrlCache.has('large-0')).toBe(false)
    expect(blobUrlCache.get('large-1')).toBe('blob:large-1')
    expect(inspectCustomPetMediaCache().retainedBytes).toBe(entryBytes)
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:large-0')
  })

  it('rejects an extreme bundle before allocating a canvas', async () => {
    stubPetRead(vi.fn().mockResolvedValue(new Uint8Array([1]).buffer))
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:oversized-sheet')
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    vi.stubGlobal(
      'Image',
      class {
        naturalWidth = 2_048
        naturalHeight = Math.floor(MAX_CUSTOM_PET_SHEET_PIXELS / this.naturalWidth) + 1
        onload: (() => void) | null = null
        set src(_value: string) {
          queueMicrotask(() => this.onload?.())
        }
      }
    )
    const createElement = vi.fn()
    vi.stubGlobal('document', { createElement })

    await expect(
      loadCustomBlobUrl('oversized-sheet', 'sheet.png', 'image/png', 'bundle')
    ).resolves.toBeNull()

    expect(createElement).not.toHaveBeenCalled()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:oversized-sheet')
    expect(blobUrlCache.has('oversized-sheet')).toBe(false)
  })

  it('does not let stale load completions evict retained active media', async () => {
    const resolvers = new Map<string, (buffer: ArrayBuffer) => void>()
    const read = vi.fn(
      (id: string) =>
        new Promise<ArrayBuffer>((resolve) => {
          resolvers.set(id, resolve)
        })
    )
    stubPetRead(read)
    let blobIndex = 0
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:pet-${blobIndex++}`)
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const releaseActive = retainCustomPetBlobCacheEntry('pet-16')
    const activeLoad = loadCustomBlobUrl('pet-16', 'pet.png', 'image/png')
    const staleLoads = Array.from({ length: 15 }, (_, index) =>
      loadCustomBlobUrl(`pet-${index}`, 'pet.png', 'image/png')
    )
    const resolveLoad = async (
      id: string,
      load: Promise<string | null>,
      value: number
    ): Promise<string | null> => {
      while (!resolvers.has(id)) {
        await Promise.resolve()
      }
      resolvers.get(id)!(new Uint8Array([value]).buffer)
      resolvers.delete(id)
      return load
    }

    try {
      const activeUrl = await resolveLoad('pet-16', activeLoad, 16)
      const activeBitmap = { close: vi.fn() } as unknown as ImageBitmap
      detectedSpriteCache.set('pet-16', { bitmaps: [activeBitmap], fps: 8, frames: [] })

      for (let index = 0; index < staleLoads.length; index += 1) {
        await resolveLoad(`pet-${index}`, staleLoads[index], index)
      }

      expect(blobUrlCache.get('pet-16')).toBe(activeUrl)
      expect(revokeObjectURL).not.toHaveBeenCalledWith(activeUrl)
      expect(activeBitmap.close).not.toHaveBeenCalled()
      expect(blobUrlCache.size).toBe(CUSTOM_PET_BLOB_CACHE_MAX)

      const overflowLoad = loadCustomBlobUrl('pet-17', 'pet.png', 'image/png')
      await resolveLoad('pet-17', overflowLoad, 17)
      expect(blobUrlCache.get('pet-16')).toBe(activeUrl)

      releaseActive()
      const nextLoad = loadCustomBlobUrl('pet-18', 'pet.png', 'image/png')
      await resolveLoad('pet-18', nextLoad, 18)

      expect(blobUrlCache.has('pet-16')).toBe(false)
      expect(revokeObjectURL).toHaveBeenCalledWith(activeUrl)
      expect(activeBitmap.close).toHaveBeenCalledTimes(1)
    } finally {
      releaseActive()
    }
  })

  it('rejects a retained overflow instead of exceeding the hard cache cap', async () => {
    const read = vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]).buffer)
    stubPetRead(read)
    let blobIndex = 0
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:retained-${blobIndex++}`)
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const releases = Array.from({ length: 17 }, (_, index) =>
      retainCustomPetBlobCacheEntry(`retained-${index}`)
    )

    try {
      for (let index = 0; index < CUSTOM_PET_BLOB_CACHE_MAX; index += 1) {
        await loadCustomBlobUrl(`retained-${index}`, 'pet.png', 'image/png')
      }
      await expect(
        loadCustomBlobUrl(`retained-${CUSTOM_PET_BLOB_CACHE_MAX}`, 'pet.png', 'image/png')
      ).resolves.toBeNull()
      expect(blobUrlCache.size).toBe(CUSTOM_PET_BLOB_CACHE_MAX)

      releases[0]()
      await expect(
        loadCustomBlobUrl(`retained-${CUSTOM_PET_BLOB_CACHE_MAX}`, 'pet.png', 'image/png')
      ).resolves.toBe(`blob:retained-${CUSTOM_PET_BLOB_CACHE_MAX + 1}`)
      expect(blobUrlCache.has('retained-0')).toBe(false)
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:retained-0')
    } finally {
      for (const release of releases) {
        release()
      }
    }
  })
})
