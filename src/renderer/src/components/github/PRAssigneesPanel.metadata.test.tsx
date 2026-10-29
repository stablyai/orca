// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitHubWorkItem } from '../../../../shared/github/work-item-types'
import { clearGitHubSlugMetadataCache } from '@/hooks/useGitHubSlugMetadata'
import { PRAssigneesPanel } from './PRAssigneesPanel'

type PanelStoreState = { repos: [] }

vi.mock('@/store', () => ({
  useAppStore: (select: (state: PanelStoreState) => unknown) => select({ repos: [] })
}))
vi.mock('@/lib/github-source-runtime-context', () => ({
  getGitHubRepoRoutingTarget: () => ({ kind: 'local' })
}))
vi.mock('@/hooks/useIssueMetadata', async () => {
  const { useRepoAssignees } = await import('@/hooks/useGitHubRepoMetadata')
  return { useRepoAssignees, useImmediateMutation: () => ({ isPending: () => false }) }
})
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

const bySlug = vi.fn()
const byPath = vi.fn()
let root: Root

async function render(repoId: string, url: string, repoPath: string | null): Promise<void> {
  const item: GitHubWorkItem = {
    id: 'pr:42',
    repoId,
    type: 'pr',
    number: 42,
    title: 'Example',
    state: 'open',
    url,
    labels: [],
    updatedAt: '',
    author: null
  }
  await act(async () => {
    root.render(
      <PRAssigneesPanel
        item={item}
        repoPath={repoPath}
        projectOrigin={undefined}
        onMutated={() => {}}
      />
    )
  })
}

describe('assignee panel metadata source selection', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    clearGitHubSlugMetadataCache()
    bySlug.mockReset().mockResolvedValue({ ok: true, users: [] })
    byPath.mockReset().mockResolvedValue([])
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { gh: { listAssignableUsersBySlug: bySlug, listAssignableUsers: byPath } }
    })
    const container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    document.body.replaceChildren()
    vi.unstubAllGlobals()
  })

  it('loads only the slug source even when a registered repo and path are available', async () => {
    await render('registered-with-url', 'https://github.com/acme/orca/pull/42', '/repo')

    expect(bySlug).toHaveBeenCalledExactlyOnceWith({
      owner: 'acme',
      repo: 'orca',
      host: 'github.com'
    })
    expect(byPath).not.toHaveBeenCalled()
  })

  it('retains path loading when the item has no repository slug', async () => {
    await render('path-only', '', '/folder')

    expect(byPath).toHaveBeenCalledExactlyOnceWith({ repoId: 'path-only', repoPath: '/folder' })
    expect(bySlug).not.toHaveBeenCalled()
  })

  it('retains repo-id loading without a checkout path or slug', async () => {
    await render('id-only', '', null)

    expect(byPath).toHaveBeenCalledExactlyOnceWith({ repoId: 'id-only', repoPath: '' })
    expect(bySlug).not.toHaveBeenCalled()
  })
})
