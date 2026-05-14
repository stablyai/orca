import { createStore, type StoreApi } from 'zustand/vanilla'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createKeybindingsSlice } from './keybindings'
import type { AppState } from '../types'
import type { KeybindingSnapshot } from '../../../../shared/keybindings/keybinding-types'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('createKeybindingsSlice', () => {
  it('should fetch and reload main-owned keybinding snapshots', async () => {
    // Arrange
    const first = snapshot(1)
    const second = snapshot(2)
    const getSnapshot = vi.fn().mockResolvedValue(first)
    const reload = vi.fn().mockResolvedValue(second)
    vi.stubGlobal('window', {
      api: {
        keybindings: {
          getSnapshot,
          reload
        }
      }
    })
    const store = createKeybindingsStore()

    // Act
    await store.getState().fetchKeybindings()
    await store.getState().reloadKeybindings()

    // Assert
    expect(store.getState().keybindingSnapshot).toEqual(second)
    expect(getSnapshot).toHaveBeenCalledTimes(1)
    expect(reload).toHaveBeenCalledTimes(1)
  })
})

function createKeybindingsStore(): StoreApi<AppState> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return createStore<any>()((...args: any[]) => ({
    ...createKeybindingsSlice(...(args as Parameters<typeof createKeybindingsSlice>))
  })) as StoreApi<AppState>
}

function snapshot(loadedAt: number): KeybindingSnapshot {
  return {
    configPath: '/home/will/.orca/keybindings.toml',
    displayPath: '~/.orca/keybindings.toml',
    fileState: 'loaded',
    loadedAt,
    keymap: {
      platform: 'linux',
      diagnostics: [],
      bindings: []
    }
  }
}
