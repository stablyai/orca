import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installApi, type MemoryStorage } from './web-preload-api-test-harness'

const KEYBOARD_KEY = 'orca.web.keybindings.v1'
const MOUSE_KEY = 'orca.web.keybindingsMouse.v1'

type StoredDocument = {
  keybindings?: Record<string, string[]>
  platforms?: Record<string, Record<string, string[]>>
}

function readStored(storage: MemoryStorage, key: string): StoredDocument | null {
  const raw = storage.getItem(key)
  if (raw === null) {
    return null
  }
  const parsed: StoredDocument = JSON.parse(raw)
  return parsed
}

describe('web keybindings mouse storage', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.doUnmock('./web-runtime-client')
  })

  it('persists a mouse binding under its own key and rejoins it on read', async () => {
    const { api, storage } = await installApi('Linux')

    const snapshot = await api.keybindings.setAction({
      actionId: 'worktree.palette',
      bindings: ['Ctrl+Alt+J', 'Shift+MouseBack']
    })

    expect(snapshot.overrides['worktree.palette']).toEqual(['Ctrl+Alt+J', 'Shift+MouseBack'])
    expect(readStored(storage, KEYBOARD_KEY)?.platforms?.linux).toEqual({
      'worktree.palette': ['Ctrl+Alt+J']
    })
    expect(readStored(storage, MOUSE_KEY)?.platforms?.linux).toEqual({
      'worktree.palette': ['Shift+MouseBack']
    })
  })

  it('leaves the keyboard shortcut intact for a bundle that cannot parse the mouse token', async () => {
    const { api, storage } = await installApi('Linux')

    await api.keybindings.setAction({
      actionId: 'worktree.palette',
      bindings: ['Ctrl+Alt+J', 'MouseBack']
    })

    // A bundle shipped before MouseBack existed never reads or writes this key.
    storage.removeItem(MOUSE_KEY)

    const reloaded = await api.keybindings.get()
    expect(reloaded.overrides['worktree.palette']).toEqual(['Ctrl+Alt+J'])
  })

  it('removes the mouse key once the last mouse binding is gone', async () => {
    const { api, storage } = await installApi('Linux')

    await api.keybindings.setAction({
      actionId: 'worktree.palette',
      bindings: ['Ctrl+Alt+J', 'MouseBack']
    })
    expect(storage.getItem(MOUSE_KEY)).not.toBeNull()

    await api.keybindings.setAction({
      actionId: 'worktree.palette',
      bindings: ['Ctrl+Alt+J']
    })
    expect(storage.getItem(MOUSE_KEY)).toBeNull()
  })

  it('never creates the mouse key for keyboard-only edits', async () => {
    const { api, storage } = await installApi('Linux')

    await api.keybindings.setAction({ actionId: 'worktree.palette', bindings: ['Ctrl+Alt+J'] })

    expect(storage.getItem(MOUSE_KEY)).toBeNull()
  })

  it('clears both keys when an action is reset', async () => {
    const { api, storage } = await installApi('Linux')

    await api.keybindings.setAction({
      actionId: 'worktree.palette',
      bindings: ['Ctrl+Alt+J', 'MouseBack']
    })
    const reset = await api.keybindings.setAction({
      actionId: 'worktree.palette',
      bindings: null
    })

    expect(reset.overrides['worktree.palette']).toBeUndefined()
    expect(storage.getItem(MOUSE_KEY)).toBeNull()
  })

  it('keeps a mouse-only binding when an unrelated action is edited', async () => {
    const { api } = await installApi('Linux')

    await api.keybindings.setAction({ actionId: 'worktree.palette', bindings: ['MouseBack'] })
    const snapshot = await api.keybindings.setAction({
      actionId: 'worktree.quickOpen',
      bindings: ['Ctrl+Alt+O']
    })

    expect(snapshot.overrides['worktree.palette']).toEqual(['MouseBack'])
    expect(snapshot.overrides['worktree.quickOpen']).toEqual(['Ctrl+Alt+O'])
  })

  it('keeps the bindings it understands and reports only the entry it dropped', async () => {
    const { api, storage } = await installApi('Linux')
    storage.setItem(
      KEYBOARD_KEY,
      JSON.stringify({
        version: 1,
        keybindings: { 'worktree.palette': ['Ctrl+Alt+J', 'Ctrl+NotAKey'] },
        platforms: {}
      })
    )

    const snapshot = await api.keybindings.get()

    expect(snapshot.overrides['worktree.palette']).toEqual(['Ctrl+Alt+J'])
    expect(snapshot.diagnostics).toHaveLength(1)
    expect(snapshot.diagnostics[0]).toMatchObject({
      severity: 'error',
      section: 'keybindings',
      actionId: 'worktree.palette'
    })
  })

  it('falls back to the action defaults when no stored binding survived', async () => {
    const { api, storage } = await installApi('Linux')
    storage.setItem(
      KEYBOARD_KEY,
      JSON.stringify({
        version: 1,
        keybindings: { 'worktree.palette': ['Ctrl+NotAKey'] },
        platforms: {}
      })
    )

    const snapshot = await api.keybindings.get()

    expect(snapshot.overrides['worktree.palette']).toBeUndefined()
    expect(snapshot.diagnostics).toHaveLength(1)
  })
})
