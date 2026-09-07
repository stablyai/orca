// @vitest-environment happy-dom
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { readJson, writeJson, UI_STORAGE_KEY } from './preload-api/web-storage'
import { createWebWorkspaceSessionApi } from './preload-api/web-workspace-session-api'
import { createStoredWebRuntimeEnvironment } from './web-runtime-environment'
import { getDefaultWorkspaceSession } from '../../../shared/constants'

vi.mock('./preload-api/web-runtime-session', () => ({
  requireActiveEnvironmentOrNull: () => ({ id: 'active-owner' })
}))
vi.mock('./preload-api/web-preferences-store', () => ({ readLocalWebUIState: () => ({}) }))
beforeEach(() => {
  const data = new Map<string, string>()
  Object.assign(window, {
    orcaWorkspaceWindowNative: {
      localRuntimeId: 'native-owner',
      presentationStorage: {
        getItem: (key: string) => data.get(key) ?? null,
        setItem: (key: string, value: string) => {
          data.set(key, value)
        }
      }
    }
  })
  localStorage.clear()
})
afterEach(() => {
  delete window.orcaWorkspaceWindowNative
})

it('merges origin-local preferences with authoritative native window presentation', () => {
  localStorage.setItem(
    UI_STORAGE_KEY,
    JSON.stringify({ uiZoomLevel: 2, rightSidebarOpen: true, activeView: 'landing' })
  )
  window.orcaWorkspaceWindowNative!.presentationStorage!.setItem(
    UI_STORAGE_KEY,
    JSON.stringify({ activeView: 'terminal' })
  )
  expect(readJson(UI_STORAGE_KEY, { uiZoomLevel: 0 })).toEqual({
    uiZoomLevel: 2,
    rightSidebarOpen: true,
    activeView: 'terminal'
  })
})

it('restores layout and the final editor checkpoint after browser origin storage is lost', async () => {
  const api = createWebWorkspaceSessionApi().session!
  const session = {
    ...getDefaultWorkspaceSession(),
    openFilesByWorktree: {
      folder: [
        {
          filePath: '/draft.md',
          relativePath: 'draft.md',
          worktreeId: 'folder',
          language: 'markdown',
          runtimeEnvironmentId: 'remote',
          dirtyDraftContent: 'unsaved'
        }
      ]
    }
  }
  writeJson(UI_STORAGE_KEY, { windowPaneLayout: { selected: 'saved' } })
  api.setSync(session)
  localStorage.clear()
  expect(readJson(UI_STORAGE_KEY, {})).toEqual({ windowPaneLayout: { selected: 'saved' } })
  expect((await api.get()).openFilesByWorktree).toEqual(session.openFilesByWorktree)
})

it('retains only the same authenticated runtime alias across origins', () => {
  const offer = {
    v: 2 as const,
    endpoint: 'ws://localhost:1',
    deviceToken: 'token',
    publicKeyB64: 'key-a'
  }
  const first = createStoredWebRuntimeEnvironment({ name: 'Owner', offer })
  localStorage.clear()
  const same = createStoredWebRuntimeEnvironment({
    name: 'Owner',
    offer: { ...offer, endpoint: 'ws://localhost:2' }
  })
  expect(same.id).toBe(first.id)
  const other = createStoredWebRuntimeEnvironment({
    name: 'Other',
    offer: { ...offer, publicKeyB64: 'key-b' }
  })
  expect(other.id).not.toBe(first.id)
})
