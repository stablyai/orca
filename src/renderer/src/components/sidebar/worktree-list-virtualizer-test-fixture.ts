import type * as ReactVirtual from '@tanstack/react-virtual'
import { vi } from 'vitest'

export async function createWorktreeListVirtualizerTestModule() {
  const actual = await vi.importActual<typeof ReactVirtual>('@tanstack/react-virtual')
  const useVirtualizer: typeof actual.useVirtualizer = (options) =>
    actual.useVirtualizer({
      ...options,
      // happy-dom has no layout; keep TanStack's real sizing, keys and range selection.
      initialRect: { width: 320, height: 768 },
      observeElementRect: (_instance, callback) => {
        callback({ width: 320, height: 768 })
      }
    })
  return { ...actual, useVirtualizer }
}
