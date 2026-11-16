import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createUIStore, makePersistedUI } from './ui-slice-test-harness'
import {
  wslMovedProjectKey,
  type WslMovedProject
} from '../../../../../shared/wsl-move/wsl-moved-project'

const ubuntuRepo: WslMovedProject = {
  kind: 'repo',
  id: 'repo-1',
  displayName: 'app',
  path: '\\\\wsl.localhost\\Ubuntu\\home\\me\\app',
  distro: 'Ubuntu'
}
const ubuntuFolder: WslMovedProject = {
  kind: 'folder',
  id: 'folder-1',
  displayName: 'notes',
  path: '\\\\wsl.localhost\\Ubuntu\\home\\me\\notes',
  distro: 'Ubuntu'
}

describe('moved-to-WSL sidebar list state', () => {
  const uiSet = vi.fn(() => Promise.resolve())
  beforeEach(() => {
    uiSet.mockClear()
    vi.stubGlobal('window', { api: { ui: { set: uiSet } } })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('persists the collapsed state only when it changes', () => {
    const store = createUIStore()
    store.getState().setWslMovedSectionCollapsed(true)
    store.getState().setWslMovedSectionCollapsed(true)
    expect(store.getState().wslMovedSectionCollapsed).toBe(true)
    expect(uiSet).toHaveBeenCalledTimes(1)
    expect(uiSet).toHaveBeenCalledWith({ wslMovedSectionCollapsed: true })
  })

  it('persists a hidden entry once', () => {
    const store = createUIStore()
    store.getState().hideWslMovedProject(ubuntuRepo)
    store.getState().hideWslMovedProject(ubuntuRepo)
    expect(store.getState().hiddenWslMovedProjectKeys).toEqual([wslMovedProjectKey(ubuntuRepo)])
    expect(uiSet).toHaveBeenCalledTimes(1)
  })

  it('keys a hidden entry by distro, so a move to another host lists again', () => {
    expect(wslMovedProjectKey(ubuntuRepo)).not.toBe(
      wslMovedProjectKey({ ...ubuntuRepo, distro: 'Debian' })
    )
  })

  it('drops hidden keys of projects no longer moved and writes nothing otherwise', () => {
    const store = createUIStore()
    store.getState().hideWslMovedProject(ubuntuRepo)
    store.getState().hideWslMovedProject(ubuntuFolder)
    uiSet.mockClear()

    store.getState().retainHiddenWslMovedProjects([ubuntuRepo, ubuntuFolder])
    expect(uiSet).not.toHaveBeenCalled()

    store.getState().retainHiddenWslMovedProjects([ubuntuFolder])
    expect(store.getState().hiddenWslMovedProjectKeys).toEqual([wslMovedProjectKey(ubuntuFolder)])
    expect(uiSet).toHaveBeenCalledWith({
      hiddenWslMovedProjectKeys: [wslMovedProjectKey(ubuntuFolder)]
    })
  })

  it('hydrates both fields across restarts and drops corrupt keys', () => {
    const store = createUIStore()
    store.getState().hydratePersistedUI(
      makePersistedUI({
        wslMovedSectionCollapsed: true,
        hiddenWslMovedProjectKeys: [
          wslMovedProjectKey(ubuntuRepo),
          wslMovedProjectKey(ubuntuRepo),
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: exercises a corrupt persisted value.
          7 as unknown as string
        ]
      })
    )
    expect(store.getState().wslMovedSectionCollapsed).toBe(true)
    expect(store.getState().hiddenWslMovedProjectKeys).toEqual([wslMovedProjectKey(ubuntuRepo)])
  })

  it('hydrates an older profile as expanded with nothing hidden', () => {
    const store = createUIStore()
    store.getState().hydratePersistedUI(makePersistedUI())
    expect(store.getState().wslMovedSectionCollapsed).toBe(false)
    expect(store.getState().hiddenWslMovedProjectKeys).toEqual([])
  })
})
