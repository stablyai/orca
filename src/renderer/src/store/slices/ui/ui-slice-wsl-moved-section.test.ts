import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createUIStore, makePersistedUI } from './ui-slice-test-harness'
import { fetchWslMovedProjects } from '../../repos/wsl-moved-projects'
import type { WslMovedProject } from '../../../../../shared/wsl-move/wsl-moved-project'

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
const REPO_KEY = 'Ubuntu\u0000repo:repo-1'
const FOLDER_KEY = 'Ubuntu\u0000folder:folder-1'

const uiSet = vi.fn((_update: Record<string, unknown>) => Promise.resolve())
const listWslMoved = vi.fn(() => Promise.resolve<WslMovedProject[]>([]))
beforeEach(() => {
  uiSet.mockClear()
  vi.stubGlobal('window', { api: { ui: { set: uiSet }, repos: { listWslMoved } } })
})
afterEach(() => {
  vi.unstubAllGlobals()
})

/** The hidden keys the last write saved, as main would hold them. */
function savedHiddenKeys(): unknown {
  return uiSet.mock.calls.findLast(([update]) => 'hiddenWslMovedProjectKeys' in update)?.[0]
    .hiddenWslMovedProjectKeys
}

describe('moved-to-WSL sidebar list state', () => {
  it('saves a hidden entry once, keyed by distro, kind and id', () => {
    const store = createUIStore()
    store.getState().hideWslMovedProject(ubuntuRepo)
    store.getState().hideWslMovedProject(ubuntuRepo)
    store.getState().hideWslMovedProject({ ...ubuntuRepo, distro: 'Debian' })
    expect(store.getState().hiddenWslMovedProjectKeys).toEqual([
      REPO_KEY,
      'Debian\u0000repo:repo-1'
    ])
    expect(savedHiddenKeys()).toEqual([REPO_KEY, 'Debian\u0000repo:repo-1'])
  })

  it('hydrates both fields across restarts and drops corrupt keys', () => {
    const store = createUIStore()
    store.getState().hydratePersistedUI(
      makePersistedUI({
        wslMovedSectionCollapsed: true,
        hiddenWslMovedProjectKeys: [
          REPO_KEY,
          REPO_KEY,
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: exercises a corrupt persisted value.
          7 as unknown as string
        ]
      })
    )
    expect(store.getState().wslMovedSectionCollapsed).toBe(true)
    expect(store.getState().hiddenWslMovedProjectKeys).toEqual([REPO_KEY])
  })
})

describe('the startup read of moved projects', () => {
  function storeHiding(keys: string[]) {
    const store = createUIStore()
    store.setState({ wslMovedProjects: [], hiddenWslMovedProjectKeys: keys })
    uiSet.mockClear()
    return store
  }

  it('forgets hidden keys of projects no longer moved', async () => {
    const store = storeHiding([REPO_KEY, FOLDER_KEY])
    listWslMoved.mockResolvedValueOnce([ubuntuFolder])
    await fetchWslMovedProjects(store.setState, store.getState)
    expect(store.getState().wslMovedProjects).toEqual([ubuntuFolder])
    expect(store.getState().hiddenWslMovedProjectKeys).toEqual([FOLDER_KEY])
    expect(savedHiddenKeys()).toEqual([FOLDER_KEY])
  })

  it('keeps hidden keys when the read fails', async () => {
    const store = storeHiding([REPO_KEY])
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    listWslMoved.mockRejectedValueOnce(new Error('journal unreadable'))
    await fetchWslMovedProjects(store.setState, store.getState)
    expect(store.getState().hiddenWslMovedProjectKeys).toEqual([REPO_KEY])
    expect(savedHiddenKeys()).toBeUndefined()
  })

  // A web client runs the same startup read, but its list is always empty.
  it('never prunes on a web client, which writes nothing', async () => {
    vi.stubGlobal('window', {
      __ORCA_WEB_CLIENT__: true,
      api: { ui: { set: uiSet }, repos: { listWslMoved } }
    })
    const store = storeHiding([REPO_KEY])
    listWslMoved.mockResolvedValueOnce([])
    await fetchWslMovedProjects(store.setState, store.getState)
    expect(store.getState().hiddenWslMovedProjectKeys).toEqual([REPO_KEY])
    expect(savedHiddenKeys()).toBeUndefined()
  })
})
