import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  EMPTY_CLOUD_WORKSPACE_PREFS,
  type CloudWorkspacePrefsDocument
} from '../../../../shared/cloud-workspaces/cloud-workspaces-wire'
import { setPinned } from '../../../../shared/cloud-workspaces/cloud-workspace-arrangement'
import {
  editCloudWorkspacePrefs,
  getCloudWorkspacePrefs,
  refreshCloudWorkspacePrefs,
  resetCloudWorkspacePrefsForTests,
  setPrefsAccount
} from './cloud-workspace-prefs'

const toastError = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({ toast: { error: toastError } }))

const A = `sbx_${'a'.repeat(24)}`
const B = `sbx_${'b'.repeat(24)}`

/** A control plane with compare-and-set, plus a hook to simulate another device writing first. */
function fakeServer() {
  const server: { document: CloudWorkspacePrefsDocument; revision: number } = {
    document: EMPTY_CLOUD_WORKSPACE_PREFS,
    revision: 0
  }
  const view = () => ({ ok: true as const, value: { ...server, updatedAt: null } })
  let failPuts = false
  const api = {
    getPrefs: vi.fn(async () => view()),
    putPrefs: vi.fn(async (document: CloudWorkspacePrefsDocument, revision: number) => {
      if (failPuts) {
        return { ok: false as const, error: 'unavailable' }
      }
      if (revision !== server.revision) {
        return { ok: false as const, error: 'conflict', reason: 'stale_revision' }
      }
      server.document = document
      server.revision += 1
      return view()
    })
  }
  return {
    server,
    api,
    otherDevice: (edit: (doc: CloudWorkspacePrefsDocument) => CloudWorkspacePrefsDocument) => {
      server.document = edit(server.document)
      server.revision += 1
    },
    failPuts: (value: boolean) => {
      failPuts = value
    }
  }
}

describe('cloud workspace prefs sync', () => {
  let fake: ReturnType<typeof fakeServer>
  beforeEach(() => {
    resetCloudWorkspacePrefsForTests()
    toastError.mockReset()
    fake = fakeServer()
    vi.stubGlobal('window', { api: { cloudWorkspaces: fake.api } })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('shows an edit at once and saves it', async () => {
    setPrefsAccount('u:org')
    await refreshCloudWorkspacePrefs()
    const saved = editCloudWorkspacePrefs((doc) => setPinned(doc, A, true))
    expect(getCloudWorkspacePrefs().document.pinned).toEqual([A])
    await saved
    expect(fake.server).toMatchObject({ document: { pinned: [A] }, revision: 1 })
    expect(getCloudWorkspacePrefs().document.pinned).toEqual([A])
  })

  it('re-applies an edit on top of a write from another device', async () => {
    setPrefsAccount('u:org')
    await refreshCloudWorkspacePrefs()
    fake.otherDevice((doc) => setPinned(doc, B, true))
    await editCloudWorkspacePrefs((doc) => setPinned(doc, A, true))
    expect(fake.api.putPrefs).toHaveBeenCalledTimes(2)
    expect(fake.server.document.pinned).toEqual([B, A])
    expect(getCloudWorkspacePrefs().document.pinned).toEqual([B, A])
  })

  it('drops a failed edit and says so', async () => {
    setPrefsAccount('u:org')
    await refreshCloudWorkspacePrefs()
    fake.failPuts(true)
    await editCloudWorkspacePrefs((doc) => setPinned(doc, A, true))
    expect(getCloudWorkspacePrefs().document.pinned).toEqual([])
    expect(toastError).toHaveBeenCalledTimes(1)
  })

  it('picks up remote edits on refresh and starts empty for another account', async () => {
    setPrefsAccount('u:org')
    await refreshCloudWorkspacePrefs()
    fake.otherDevice((doc) => setPinned(doc, B, true))
    await refreshCloudWorkspacePrefs()
    expect(getCloudWorkspacePrefs().document.pinned).toEqual([B])
    setPrefsAccount('u:other')
    expect(getCloudWorkspacePrefs()).toMatchObject({ account: 'u:other', loaded: false })
    expect(getCloudWorkspacePrefs().document.pinned).toEqual([])
  })
})
