// @vitest-environment happy-dom
import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { appState, cacheMocks } = vi.hoisted(() => ({
  appState: {
    current: {
      petId: 'generated-a',
      customPets: [
        {
          id: 'generated-a',
          label: 'Generated A',
          fileName: 'spritesheet.webp',
          mimeType: 'image/webp',
          kind: 'bundle' as const
        }
      ]
    }
  },
  cacheMocks: {
    peek: vi.fn(() => null),
    read: vi.fn(() => null),
    load: vi.fn(() => Promise.resolve<string | null>(null)),
    retain: vi.fn(() => () => {})
  }
}))

vi.mock('../../store', () => ({
  useAppStore: (selector: (state: typeof appState.current) => unknown) => selector(appState.current)
}))

vi.mock('./pet-blob-cache', () => ({
  detectedSpriteCache: new Map(),
  loadCustomBlobUrl: cacheMocks.load,
  peekCustomPetBlobUrl: cacheMocks.peek,
  readCustomPetBlobUrl: cacheMocks.read,
  retainCustomPetBlobCacheEntry: cacheMocks.retain
}))

import { usePetUrl } from './usePetUrl'
import { BUNDLED_PET } from './pet-models'

beforeEach(() => {
  cacheMocks.peek.mockClear()
  cacheMocks.read.mockClear()
  cacheMocks.load.mockClear()
  cacheMocks.retain.mockClear()
})

describe('usePetUrl when the art cannot be read', () => {
  // Why this pet shape: a freshly generated pet is never in the blob cache, so
  // it always takes the IPC read — the one path where a rejection is certain to
  // reach the hook rather than a warm cache hit.
  it('reports a rejected read instead of leaving it unhandled', async () => {
    const failure = new Error('pet read failed')
    cacheMocks.load.mockReturnValueOnce(Promise.reject(failure))
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})

    const hook = renderHook(() => usePetUrl())

    await waitFor(() => expect(logged).toHaveBeenCalled())
    expect(logged.mock.calls.some((call) => call.includes(failure))).toBe(true)
    // The overlay is never blank: the bundled default stands in.
    expect(hook.result.current.url).toBe(BUNDLED_PET.url)

    logged.mockRestore()
  })
})
