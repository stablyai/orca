import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/types'
import { getSetupScriptPromptDismissalKey } from '../../lib/setup-script-prompt'
import { createTestStore } from './store-test-helpers'

const localRepo: Repo = {
  id: 'local-repo',
  path: '/local',
  displayName: 'Local',
  badgeColor: '#000',
  addedAt: 1
}

const reposList = vi.fn()

beforeEach(() => {
  reposList.mockReset()
  vi.stubGlobal('window', {
    api: {
      repos: {
        list: reposList
      }
    }
  })
})

describe('repo setup script prompt dismissals', () => {
  it('keeps only current setup prompt dismissals for fetched repos', async () => {
    reposList.mockResolvedValue([localRepo])
    const store = createTestStore()
    store.setState({
      setupScriptPromptDismissedRepoIds: [
        localRepo.id,
        getSetupScriptPromptDismissalKey(localRepo.id),
        getSetupScriptPromptDismissalKey('stale-repo')
      ]
    })

    await store.getState().fetchRepos()

    expect(store.getState().setupScriptPromptDismissedRepoIds).toEqual([
      getSetupScriptPromptDismissalKey(localRepo.id)
    ])
  })
})
