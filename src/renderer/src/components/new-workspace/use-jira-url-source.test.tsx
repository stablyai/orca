// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { JiraConnectionStatus, JiraIssue, JiraSite } from '../../../../shared/jira-types'
import type { TaskSourceContext } from '../../../../shared/task-source-context'
import { useJiraUrlSource } from './use-jira-url-source'

const mocks = vi.hoisted(() => ({
  assertRuntimeEnvironmentCapability: vi.fn(),
  lookupJiraIssueSummary: vi.fn(),
  readJiraStatus: vi.fn()
}))

vi.mock('@/runtime/runtime-rpc-client', () => ({
  assertRuntimeEnvironmentCapability: mocks.assertRuntimeEnvironmentCapability
}))

vi.mock('@/store', () => {
  const state = {
    lookupJiraIssueSummary: mocks.lookupJiraIssueSummary,
    readJiraStatus: mocks.readJiraStatus
  }
  return {
    useAppStore: (selector: (value: typeof state) => unknown): unknown => selector(state)
  }
})

function sourceContext(hostId: TaskSourceContext['hostId'] = 'local'): TaskSourceContext {
  return {
    kind: 'task-source',
    provider: 'jira',
    projectId: 'project-1',
    hostId,
    repoId: 'repo-1',
    providerIdentity: null,
    accountLabel: null
  }
}

function site(id: string, email = `${id}@example.com`): JiraSite {
  return {
    id,
    siteUrl: 'https://company.atlassian.net',
    email,
    displayName: `Jira ${id}`,
    accountId: id
  }
}

function status(
  sites: JiraSite[],
  selectedSiteId: (string & {}) | 'all' | null = null
): JiraConnectionStatus {
  return {
    connected: true,
    viewer: null,
    sites,
    activeSiteId: null,
    selectedSiteId
  }
}

function issue(key: string, siteId = 'site-a'): JiraIssue {
  return {
    id: key,
    key,
    siteId,
    title: `Title ${key}`,
    url: `https://company.atlassian.net/browse/${key}`,
    project: { id: 'project-1', key: key.split('-')[0], name: 'Project' },
    issueType: { id: 'type-1', name: 'Task' },
    status: { id: 'status-1', name: 'To Do', categoryKey: 'new', categoryName: 'To Do' },
    labels: [],
    createdAt: '2026-07-27T00:00:00.000Z',
    updatedAt: '2026-07-27T00:00:00.000Z'
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

async function advanceLookup(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(200)
  })
}

describe('useJiraUrlSource', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    mocks.assertRuntimeEnvironmentCapability.mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('requires an explicit account choice and binds the exact account context', async () => {
    const siteA = site('site-a')
    const siteB = site('site-b', 'second@example.com')
    const context = sourceContext()
    mocks.readJiraStatus.mockResolvedValue(status([siteA, siteB], 'all'))
    mocks.lookupJiraIssueSummary.mockResolvedValue(issue('ORCA-123', 'site-b'))
    const { result } = renderHook(() =>
      useJiraUrlSource({
        value: 'https://company.atlassian.net/browse/ORCA-123',
        enabled: true,
        sourceContext: context
      })
    )

    expect(result.current.intent).toBe(true)
    expect(result.current.loading).toBe(true)
    await advanceLookup()
    expect(result.current.accountChoices.map((candidate) => candidate.id)).toEqual([
      'site-a',
      'site-b'
    ])
    expect(mocks.lookupJiraIssueSummary).not.toHaveBeenCalled()

    act(() => result.current.selectAccount('site-b'))
    await advanceLookup()

    expect(mocks.lookupJiraIssueSummary).toHaveBeenCalledWith(
      expect.objectContaining({ hostId: 'local' }),
      'ORCA-123',
      'site-b',
      { force: false, signal: expect.any(AbortSignal) }
    )
    expect(result.current.issue?.key).toBe('ORCA-123')
    expect(result.current.boundSourceContext).toMatchObject({
      provider: 'jira',
      hostId: 'local',
      repoId: 'repo-1',
      accountLabel: 'second@example.com',
      providerIdentity: {
        provider: 'jira',
        siteId: 'site-b',
        siteUrl: 'https://company.atlassian.net',
        projectKey: 'ORCA'
      }
    })
  })

  it('reuses an already-loaded connection instead of re-reading status', async () => {
    const context = sourceContext()
    const loaded = { status: status([site('site-a')], 'site-a'), loaded: true }
    mocks.lookupJiraIssueSummary.mockResolvedValue(issue('ORCA-1'))
    // Explicit: clearAllMocks keeps prior implementations, so the retry read must be this test's.
    mocks.readJiraStatus.mockResolvedValue(status([site('site-a')], 'site-a'))
    const { result } = renderHook(() =>
      useJiraUrlSource({
        value: 'https://company.atlassian.net/browse/ORCA-1',
        enabled: true,
        sourceContext: context,
        connection: loaded
      })
    )

    await advanceLookup()

    expect(mocks.readJiraStatus).not.toHaveBeenCalled()
    expect(result.current.issue?.key).toBe('ORCA-1')

    act(() => result.current.retry())
    await advanceLookup()

    // A forced retry still needs a fresh read — the cached answer is what failed.
    expect(mocks.readJiraStatus).toHaveBeenCalledTimes(1)
    expect(result.current.issue?.key).toBe('ORCA-1')
  })

  it('re-reads status when the loaded connection has no sites to match', async () => {
    const context = sourceContext()
    mocks.readJiraStatus.mockResolvedValue(status([site('site-a')], 'site-a'))
    mocks.lookupJiraIssueSummary.mockResolvedValue(issue('ORCA-1'))
    const { result } = renderHook(() =>
      useJiraUrlSource({
        value: 'https://company.atlassian.net/browse/ORCA-1',
        enabled: true,
        sourceContext: context,
        connection: { status: status([], 'site-a'), loaded: true }
      })
    )

    await advanceLookup()

    expect(mocks.readJiraStatus).toHaveBeenCalledTimes(1)
    expect(result.current.issue?.key).toBe('ORCA-1')
  })

  it('discards a late issue response after the URL changes', async () => {
    const oldIssue = deferred<JiraIssue | null>()
    let oldSignal: AbortSignal | undefined
    const context = sourceContext()
    mocks.readJiraStatus.mockResolvedValue(status([site('site-a')], 'site-a'))
    mocks.lookupJiraIssueSummary.mockImplementation(
      (
        _context: TaskSourceContext,
        key: string,
        _siteId: string,
        options: { signal?: AbortSignal }
      ) => {
        if (key === 'ORCA-1') {
          oldSignal = options.signal
          return oldIssue.promise
        }
        return Promise.resolve(issue('ORCA-2'))
      }
    )
    const { result, rerender } = renderHook(
      ({ value }) =>
        useJiraUrlSource({
          value,
          enabled: true,
          sourceContext: context
        }),
      { initialProps: { value: 'https://company.atlassian.net/browse/ORCA-1' } }
    )
    await advanceLookup()

    rerender({ value: 'https://company.atlassian.net/browse/ORCA-2' })
    await advanceLookup()
    expect(oldSignal?.aborted).toBe(true)
    expect(result.current.issue?.key).toBe('ORCA-2')

    await act(async () => {
      oldIssue.resolve(issue('ORCA-1'))
      await oldIssue.promise
    })
    expect(result.current.issue?.key).toBe('ORCA-2')
  })

  it('forces Retry past an invalid fulfilled summary result', async () => {
    const context = sourceContext()
    mocks.readJiraStatus.mockResolvedValue(status([site('site-a')], 'site-a'))
    mocks.lookupJiraIssueSummary.mockResolvedValueOnce(null).mockResolvedValueOnce(issue('ORCA-1'))
    const { result } = renderHook(() =>
      useJiraUrlSource({
        value: 'https://company.atlassian.net/browse/ORCA-1',
        enabled: true,
        sourceContext: context
      })
    )

    await advanceLookup()
    expect(result.current.errorKind).toBe('read-failed')

    act(() => result.current.retry())
    await advanceLookup()

    expect(result.current.issue?.key).toBe('ORCA-1')
    expect(mocks.lookupJiraIssueSummary).toHaveBeenLastCalledWith(context, 'ORCA-1', 'site-a', {
      force: true,
      signal: expect.any(AbortSignal)
    })
  })

  it('stops a late status response after unmount before starting an issue read', async () => {
    const lateStatus = deferred<JiraConnectionStatus>()
    const context = sourceContext()
    mocks.readJiraStatus.mockReturnValue(lateStatus.promise)
    const { unmount } = renderHook(() =>
      useJiraUrlSource({
        value: 'https://company.atlassian.net/browse/ORCA-1',
        enabled: true,
        sourceContext: context
      })
    )
    await advanceLookup()
    unmount()

    await act(async () => {
      lateStatus.resolve(status([site('site-a')], 'site-a'))
      await lateStatus.promise
    })

    expect(mocks.lookupJiraIssueSummary).not.toHaveBeenCalled()
  })

  it('surfaces a missing paired-runtime capability without reading Jira state', async () => {
    const context = sourceContext('runtime:env-1')
    mocks.assertRuntimeEnvironmentCapability.mockRejectedValueOnce(new Error('update-runtime'))
    const { result } = renderHook(() =>
      useJiraUrlSource({
        value: 'https://company.atlassian.net/browse/ORCA-1',
        enabled: true,
        sourceContext: context
      })
    )

    await advanceLookup()

    expect(result.current.errorKind).toBe('update-runtime')
    expect(mocks.readJiraStatus).not.toHaveBeenCalled()
    expect(mocks.assertRuntimeEnvironmentCapability).toHaveBeenCalledWith(
      'env-1',
      'worktree.linked-work-item-context.v1',
      'update-runtime'
    )
  })
})
