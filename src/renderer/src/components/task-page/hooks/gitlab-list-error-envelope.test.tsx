// @vitest-environment happy-dom

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useTaskPageGitLabFetch } from './use-task-page-gitlab-fetch'
import type { Repo } from '../../../../../shared/repo-types'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))
vi.mock('@/components/task-page/source/repo-source-context', () => ({
  getTaskPageRepoSourceContext: () => null
}))

// `gitlab:listIssues` throws before it returns a payload — `assertRegisteredRepo` rejects with
// "Access denied: unknown repository path" — so the renderer sees Electron's invoke envelope, and
// this banner renders errs[0] verbatim.
const ENVELOPED =
  "Error invoking remote method 'gitlab:listIssues': Error: Access denied: unknown repository path"
const REASON = 'Access denied: unknown repository path'
const ENVELOPE_ONLY = "Error invoking remote method 'gitlab:listIssues': Error"
const UNREADABLE_COPY =
  'Could not load GitLab items, and the failure did not include a readable reason.'

const repo = { id: 'repo-1', path: '/w/project' } as Repo

function renderFetch(rejection: unknown) {
  const listIssues = vi.fn().mockRejectedValue(rejection)
  ;(globalThis as unknown as { window: Window }).window.api = {
    gl: { listIssues, listMRs: vi.fn() }
  } as never

  const setGitlabError = vi.fn()
  renderHook(() =>
    useTaskPageGitLabFetch({
      taskSource: 'gitlab',
      gitlabView: 'issues',
      activeGitlabFilter: 'assigned-to-me',
      gitlabRefreshNonce: 0,
      selectedRepos: [repo],
      selectedReposKey: 'repo-1',
      primaryRepo: repo,
      gitlabIssuePage: 0,
      setGitlabItems: vi.fn(),
      setGitlabLoading: vi.fn(),
      setGitlabError,
      setGitlabIssuePage: vi.fn(),
      setGitlabIssueTotalPages: vi.fn(),
      setGitlabIssueLoadingTargetPage: vi.fn(),
      setGitlabTodos: vi.fn(),
      setGitlabTodosLoading: vi.fn()
    })
  )
  return setGitlabError
}

// Why: the effect clears the banner with setGitlabError(null) before fetching, so the asserted
// value is the last call, not the first.
async function bannerText(setGitlabError: ReturnType<typeof vi.fn>): Promise<unknown> {
  await waitFor(() => expect(setGitlabError.mock.calls.length).toBeGreaterThan(1))
  return setGitlabError.mock.calls.at(-1)?.[0]
}

describe('the GitLab task-list error banner', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  // Why: `translate` is mocked to its fallback above, and the real one prefers the catalog whenever
  // the key resolves — so without this the asserted copy is a string no user ever sees.
  it('reads that copy from the catalog, not just the inline fallback', () => {
    const catalog = JSON.parse(
      readFileSync(join(__dirname, '..', '..', '..', 'i18n', 'locales', 'en.json'), 'utf8')
    )

    expect(catalog.auto.components.TaskPage.unreadableGitlabListError).toBe(UNREADABLE_COPY)
  })

  it('shows the reason, not the IPC envelope, when a list handler rejects', async () => {
    const banner = await bannerText(renderFetch(new Error(ENVELOPED)))

    expect(banner).toBe(REASON)
    expect(banner).not.toContain('Error invoking remote method')
  })

  it('shows readable copy when the envelope carried no reason', async () => {
    const banner = await bannerText(renderFetch(new Error(ENVELOPE_ONLY)))

    expect(banner).toBe(UNREADABLE_COPY)
  })
})
