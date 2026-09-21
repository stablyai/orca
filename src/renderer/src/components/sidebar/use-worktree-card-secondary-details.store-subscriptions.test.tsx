// @vitest-environment happy-dom

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { readStoreListenerCount } from '@/store/store-listener-census'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { usePromptCacheCountdownStartedAt } from './CacheTimer'
import { useWorktreeCardSecondaryDetails } from './use-worktree-card-secondary-details'
import { useWorktreeAgentRows } from './useWorktreeAgentRows'

const mocks = vi.hoisted(() => ({ toastError: vi.fn() }))
vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))

const WORKTREE_ID = 'repo-1::/repo/worktrees/card'
const originalState = useAppStore.getState()

let root: Root | null = null
let container: HTMLDivElement | null = null

function mount(node: ReactNode): void {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root?.render(node))
}

function unmount(): void {
  if (root) {
    act(() => root?.unmount())
  }
  root = null
  container?.remove()
  container = null
}

function listenerCount(): number {
  const count = readStoreListenerCount()
  if (count === null) {
    throw new Error('store listener census unavailable')
  }
  return count
}

function makeWorktree(): Worktree {
  return {
    id: WORKTREE_ID,
    repoId: 'repo-1',
    path: '/repo/worktrees/card',
    displayName: 'Card',
    branch: 'feature/card',
    head: 'abc123',
    isBare: false,
    isMainWorktree: false,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 1
  }
}

function makeSettings(promptCacheTtlMs: number): GlobalSettings {
  return { promptCacheTimerEnabled: true, promptCacheTtlMs } as GlobalSettings
}

function secondaryDetailsArgs(settings: GlobalSettings) {
  return {
    worktree: makeWorktree(),
    repo: undefined,
    statusPrDisplay: null,
    showStatus: false,
    showIssue: false,
    showLinearIssue: false,
    showJiraIssue: false,
    showPR: false,
    showAutomation: false,
    showCli: false,
    showComment: false,
    showPorts: false,
    issueDisplay: null,
    linearIssue: null,
    linearIssueDisplay: null,
    jiraIssueDisplay: null,
    prDisplay: null,
    linkedGitLabMR: null,
    linkedBitbucketPR: null,
    linkedAzureDevOpsPR: null,
    linkedGiteaPR: null,
    cardProps: [] as never,
    newCardStyle: false,
    compactCards: false,
    agentActivityDisplayMode: 'compact' as const,
    workspacePorts: [],
    openTaskPage: (() => {}) as never,
    updateWorktreeMeta: (() => {}) as never,
    settings
  }
}

afterEach(() => {
  unmount()
  useAppStore.setState(originalState, true)
})

describe('useWorktreeCardSecondaryDetails store subscriptions', () => {
  it('adds no store listener of its own beyond the hooks it composes', () => {
    const settings = makeSettings(300_000)

    // Baseline: the two hooks it composes, mounted on their own.
    const composedBaseline = listenerCount()
    function ComposedProbe(): null {
      useWorktreeAgentRows(WORKTREE_ID, false)
      usePromptCacheCountdownStartedAt(WORKTREE_ID, true)
      return null
    }
    mount(<ComposedProbe />)
    const composedListeners = listenerCount() - composedBaseline
    unmount()

    const baseline = listenerCount()
    function Probe(): null {
      useWorktreeCardSecondaryDetails(secondaryDetailsArgs(settings))
      return null
    }
    mount(<Probe />)

    // Why: promptCacheTtlMs comes from the settings the card already subscribes to,
    // so this hook must not open a third subscription for the same field.
    expect(listenerCount() - baseline).toBe(composedListeners)

    unmount()
    expect(listenerCount()).toBe(baseline)
  })

  it('reads the cache TTL from the passed settings', () => {
    let cacheTtlMs = -1
    function Probe({ ttl }: { ttl: number }): null {
      cacheTtlMs = useWorktreeCardSecondaryDetails(
        secondaryDetailsArgs(makeSettings(ttl))
      ).cacheTtlMs
      return null
    }

    mount(<Probe ttl={300_000} />)
    expect(cacheTtlMs).toBe(300_000)

    act(() => root?.render(<Probe ttl={120_000} />))
    expect(cacheTtlMs).toBe(120_000)
  })

  it('reports no TTL while the aggregate cache timer is suppressed', () => {
    let cacheTtlMs = -1
    function Probe(): null {
      // compactCards suppresses the aggregate timer row.
      cacheTtlMs = useWorktreeCardSecondaryDetails({
        ...secondaryDetailsArgs(makeSettings(300_000)),
        compactCards: true
      }).cacheTtlMs
      return null
    }

    mount(<Probe />)
    expect(cacheTtlMs).toBe(0)
  })

  it('writes a suppression tombstone when the user unlinks a displayed GitHub PR', async () => {
    const updateWorktreeMeta = vi.fn().mockResolvedValue({ ok: true })
    let unlink: (() => Promise<void>) | null = null
    function Probe(): null {
      const details = useWorktreeCardSecondaryDetails({
        ...secondaryDetailsArgs(makeSettings(300_000)),
        worktree: { ...makeWorktree(), hostId: 'ssh:builder' },
        prDisplay: {
          provider: 'github',
          number: 42,
          title: 'Branch PR'
        },
        updateWorktreeMeta: updateWorktreeMeta as never
      })
      unlink = details.handleUnlinkReview
      return null
    }

    mount(<Probe />)
    await act(() => unlink?.())

    expect(updateWorktreeMeta).toHaveBeenCalledWith(
      WORKTREE_ID,
      { linkedPR: null, suppressedGitHubPR: 42 },
      { executionHostId: 'ssh:builder' }
    )
  })

  it('surfaces a failed GitHub unlink after the optimistic card update is reverted', async () => {
    const updateWorktreeMeta = vi.fn().mockResolvedValue({
      ok: false,
      error: 'Update the remote runtime to unlink GitHub pull requests'
    })
    let unlink: (() => Promise<void>) | null = null
    function Probe(): null {
      const details = useWorktreeCardSecondaryDetails({
        ...secondaryDetailsArgs(makeSettings(300_000)),
        prDisplay: { provider: 'github', number: 42, title: 'Branch PR' },
        updateWorktreeMeta: updateWorktreeMeta as never
      })
      unlink = details.handleUnlinkReview
      return null
    }

    mount(<Probe />)
    await act(() => unlink?.())

    expect(mocks.toastError).toHaveBeenCalledWith(
      'Update the remote runtime to unlink GitHub pull requests'
    )
  })
})
