import { afterEach, describe, expect, it, vi } from 'vitest'
import { createStore } from 'zustand/vanilla'
import type { KeybindingFileSnapshot } from '../../../../../shared/keybindings/types'
import type { AppState } from '../../types'
import { createKeybindingsSlice } from './keybindings'
import { selectFloatingWorkspaceShortcutsActive } from './floating-workspace-shortcuts-selector'

function snapshot(generation: number, active: boolean): KeybindingFileSnapshot {
  return {
    path: 'keybindings.json',
    platform: 'darwin',
    exists: true,
    overrides: active ? { 'floatingTerminal.toggle': ['Mod+Shift+J'] } : {},
    commonOverrides: {},
    platformOverrides: {},
    diagnostics: [],
    floatingWorkspaceShortcutsActive: active,
    generation
  }
}

function deferred(): {
  promise: Promise<KeybindingFileSnapshot>
  resolve: (value: KeybindingFileSnapshot) => void
} {
  let resolve!: (value: KeybindingFileSnapshot) => void
  const promise = new Promise<KeybindingFileSnapshot>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('keybinding snapshot ordering', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('drops a late reply that an off and an on broadcast already superseded', async () => {
    const openFile = deferred()
    const get = deferred()
    const setAction = deferred()
    vi.stubGlobal('window', {
      api: {
        keybindings: {
          openFile: () => openFile.promise,
          get: () => get.promise,
          setAction: () => setAction.promise
        }
      }
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the test reads and writes only the keybindings slice.
    const store = createStore<AppState>()((...args) => createKeybindingsSlice(...args) as AppState)
    const pending = [
      store.getState().openKeybindingsFile(),
      store.getState().fetchKeybindings(),
      store.getState().setKeybindingOverride('tab.newTerminal', ['Mod+T'])
    ]
    store.getState().setKeybindingSnapshot(snapshot(2, false))
    store.getState().setKeybindingSnapshot(snapshot(3, true))
    openFile.resolve(snapshot(1, false))
    get.resolve(snapshot(1, false))
    setAction.resolve(snapshot(2, false))
    await Promise.all(pending)

    expect(store.getState().keybindingSnapshot?.generation).toBe(3)
    expect(selectFloatingWorkspaceShortcutsActive(store.getState())).toBe(true)
    expect(store.getState().keybindings).toEqual({ 'floatingTerminal.toggle': ['Mod+Shift+J'] })
  })
})
