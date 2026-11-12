import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestStore } from '../testing/app-store-test-fixture'
import type { Repo } from '../../../../shared/repo-types'

const repo: Repo = { id: 'r', path: '/r', displayName: 'R', badgeColor: '#000', addedAt: 1 }
const reposUpdate = vi.fn()

beforeEach(() => {
  reposUpdate.mockReset()
  vi.stubGlobal('window', { api: { repos: { update: reposUpdate } } })
})

describe('updateRepo hiddenAt echo', () => {
  it('reports failure, and leaves the row listed, when a host drops hiddenAt', async () => {
    // A host from before hidden projects answers with its row, minus the field it does not know.
    reposUpdate.mockResolvedValue(repo)
    const store = createTestStore()
    store.setState({ repos: [repo] })

    await expect(store.getState().updateRepo('r', { hiddenAt: 5 })).resolves.toBe(false)
    expect(store.getState().repos[0]?.hiddenAt).toBeUndefined()
  })

  it('applies the hide when the host echoes it', async () => {
    reposUpdate.mockResolvedValue({ ...repo, hiddenAt: 5 })
    const store = createTestStore()
    store.setState({ repos: [repo] })

    await expect(store.getState().updateRepo('r', { hiddenAt: 5 })).resolves.toBe(true)
    expect(store.getState().repos[0]?.hiddenAt).toBe(5)
  })
})
