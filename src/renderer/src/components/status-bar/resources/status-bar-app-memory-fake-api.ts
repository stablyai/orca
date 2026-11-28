import { act } from '@testing-library/react'
import { vi } from 'vitest'

/** Stubs window.api's activity relay and app-memory read for useStatusBarAppMemory tests. */
export function installFakeAppMemoryApi(read: () => Promise<number | null>) {
  const fake = {
    reads: vi.fn(read),
    activeListeners: 0,
    setActive: (_active: boolean): void => {}
  }
  vi.stubGlobal('api', {
    ui: {
      isWindowActive: () => Promise.resolve(false),
      onWindowActiveChanged: (callback: (active: boolean) => void) => {
        fake.activeListeners++
        fake.setActive = callback
        return () => {
          fake.activeListeners--
        }
      }
    },
    memory: { getAppMemoryTotal: fake.reads }
  })
  return fake
}

export async function advanceFakeTime(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}
