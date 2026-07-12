// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { appState, cacheMocks } = vi.hoisted(() => ({
  appState: {
    current: {
      petId: 'custom-a',
      customPets: [
        {
          id: 'custom-a',
          label: 'Custom A',
          fileName: 'a.png',
          mimeType: 'image/png',
          kind: 'image' as const
        }
      ]
    }
  },
  cacheMocks: {
    peek: vi.fn(() => null),
    read: vi.fn(() => null),
    load: vi.fn(() => new Promise<null>(() => {})),
    retain: vi.fn()
  }
}))

vi.mock('../../store', () => ({
  useAppStore: (selector: (state: typeof appState.current) => unknown) =>
    selector(appState.current)
}))

vi.mock('./pet-blob-cache', () => ({
  detectedSpriteCache: new Map(),
  loadCustomBlobUrl: cacheMocks.load,
  peekCustomPetBlobUrl: cacheMocks.peek,
  readCustomPetBlobUrl: cacheMocks.read,
  retainCustomPetBlobCacheEntry: cacheMocks.retain
}))

import { usePetUrl } from './usePetUrl'

beforeEach(() => {
  cacheMocks.peek.mockClear()
  cacheMocks.read.mockClear()
  cacheMocks.load.mockClear()
  cacheMocks.retain.mockReset()
  appState.current = {
    petId: 'custom-a',
    customPets: [
      {
        id: 'custom-a',
        label: 'Custom A',
        fileName: 'a.png',
        mimeType: 'image/png',
        kind: 'image'
      }
    ]
  }
})

describe('usePetUrl cache retention', () => {
  it('retains only the committed custom pet and releases it on change and unmount', () => {
    const releaseA = vi.fn()
    const releaseB = vi.fn()
    cacheMocks.retain.mockReturnValueOnce(releaseA).mockReturnValueOnce(releaseB)
    const hook = renderHook(() => usePetUrl())

    expect(cacheMocks.retain).toHaveBeenCalledWith('custom-a')
    appState.current = {
      petId: 'custom-b',
      customPets: [
        ...appState.current.customPets,
        {
          id: 'custom-b',
          label: 'Custom B',
          fileName: 'b.png',
          mimeType: 'image/png',
          kind: 'image'
        }
      ]
    }
    hook.rerender()

    expect(releaseA).toHaveBeenCalledTimes(1)
    expect(cacheMocks.retain).toHaveBeenLastCalledWith('custom-b')
    hook.unmount()
    expect(releaseB).toHaveBeenCalledTimes(1)
  })
})
