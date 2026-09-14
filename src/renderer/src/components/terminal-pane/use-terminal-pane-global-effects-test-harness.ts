import { vi } from 'vitest'
import {
  registerLivePaneManager,
  unregisterLivePaneManager
} from '@/lib/pane-manager/pane-manager-registry'
import { useAppStore } from '@/store'

class MockResizeObserver {
  observe = vi.fn()
  disconnect = vi.fn()
}

/** Minimal window/ResizeObserver globals the hook touches, plus a clean layout store. */
export function installGlobalEffectsTestWindow(): void {
  useAppStore.setState({ terminalLayoutsByTabId: {} })
  ;(globalThis as unknown as { window: unknown }).window = {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    api: {
      ui: {
        onFileDrop: vi.fn(() => vi.fn())
      },
      pty: {
        setActiveRendererPty: vi.fn()
      }
    }
  }
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = MockResizeObserver
}

export function cleanupGlobalEffectsTestWindow(): void {
  delete (globalThis as unknown as { window?: unknown }).window
  delete (globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver
}

// Why: the live-manager registry is module-global; unregister in afterEach
// so a failed assertion cannot leak fake managers into later tests.
export function createLivePaneManagerRegistry(): {
  registerManagerForReset: <T extends { resetWebglTextureAtlases(): void }>(manager: T) => T
  unregisterAllManagers: () => void
} {
  const registeredManagers: { resetWebglTextureAtlases(): void }[] = []
  return {
    registerManagerForReset<T extends { resetWebglTextureAtlases(): void }>(manager: T): T {
      registerLivePaneManager(manager)
      registeredManagers.push(manager)
      return manager
    },
    unregisterAllManagers(): void {
      for (const manager of registeredManagers.splice(0)) {
        unregisterLivePaneManager(manager)
      }
    }
  }
}
