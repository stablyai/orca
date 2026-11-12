// Every archive, unarchive and delete from this desktop tells Home's archived count to read again
// (ARCHIVE-REACH), so a cached 0 never hides "Show archived" for its 5-minute TTL.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cloudArchiveVersion } from './cloud-archive-changes'
import { archiveCloudWorkspace, unarchiveCloudWorkspace } from './orca-cloud-workspace-actions'
import {
  noteCloudWorkspaceDeleteSettled,
  noteCloudWorkspaceDeleting
} from './pending-cloud-archive'
import { seedCloudWorkspaceSnapshot } from './orca-cloud-workspace-store'
import {
  destroyFromHome,
  unarchiveFromHome
} from '@/components/cloud-workspaces/cloud-workspace-home-archive'
import { workspace } from '@/components/cloud-workspaces/cloud-workspaces.test-fixture'

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }))

const ok = { ok: true as const, value: null }
const failed = { ok: false as const, code: 'failed' as const, message: 'x', userMessage: 'x' }

function stub(over: {
  archive?: unknown
  unarchive?: unknown
  destroy?: unknown
  patch?: unknown
}) {
  vi.stubGlobal('window', {
    api: {
      orcaCloudWorkspace: {
        archive: vi.fn(async () => over.archive ?? ok),
        unarchive: vi.fn(async () => over.unarchive ?? ok),
        // The actions refresh status afterwards; not under test here.
        getStatus: vi.fn(async () => failed)
      },
      cloudWorkspaces: {
        destroy: vi.fn(async () => over.destroy ?? { ok: true, value: null }),
        patch: vi.fn(async () => over.patch ?? { ok: true, value: {} }),
        localWorkspaces: vi.fn(async () => [])
      }
    }
  })
}

beforeEach(() => seedCloudWorkspaceSnapshot({}))
afterEach(() => vi.unstubAllGlobals())

const sleep = async () => [{ completed: true }]

describe('archive changes from this desktop', () => {
  it('archive and unarchive that succeed bump the version; a failed archive does not', async () => {
    stub({})
    const start = cloudArchiveVersion()
    await archiveCloudWorkspace('w1', { sleep })
    expect(cloudArchiveVersion()).toBe(start + 1)
    await unarchiveCloudWorkspace('w1', { wake: async () => undefined })
    expect(cloudArchiveVersion()).toBe(start + 2)
    stub({ archive: failed })
    await archiveCloudWorkspace('w1', { sleep })
    expect(cloudArchiveVersion()).toBe(start + 2)
  })

  it('a sidebar delete, once settled, bumps the version', () => {
    const start = cloudArchiveVersion()
    noteCloudWorkspaceDeleting('w2')
    noteCloudWorkspaceDeleteSettled('w2')
    expect(cloudArchiveVersion()).toBe(start + 1)
  })

  it('Home’s delete and remote unarchive bump it too', async () => {
    stub({})
    const w = workspace({ id: 'sbx_remote' })
    const start = cloudArchiveVersion()
    await destroyFromHome(w, 'remote')
    expect(cloudArchiveVersion()).toBe(start + 1)
    await unarchiveFromHome(w, 'remote')
    expect(cloudArchiveVersion()).toBe(start + 2)
  })
})
