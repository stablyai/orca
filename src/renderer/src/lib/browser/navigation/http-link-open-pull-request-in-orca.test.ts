import { afterEach, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import '@/store/testing/app-store-test-fixture'
import { TEST_REPO } from '@/store/repos/repo.test-fixture'
import { openGitHubPullRequestUrlInOrca } from './http-link-open-pull-request-in-orca'

afterEach(() => {
  vi.unstubAllGlobals()
  toast.dismiss()
})

it('reports a failed PR lookup instead of rejecting the link action', async () => {
  useAppStore.setState({ ...useAppStore.getInitialState(), repos: [TEST_REPO] })
  vi.stubGlobal('window', {
    api: {
      gh: {
        repoSlug: async () => ({ owner: 'stablyai', repo: 'orca' }),
        workItemByOwnerRepo: async () => {
          throw new Error('IPC unavailable')
        }
      }
    }
  })

  await openGitHubPullRequestUrlInOrca('https://github.com/stablyai/orca/pull/42092')

  expect(toast.getToasts().at(-1)).toMatchObject({ type: 'error' })
})
