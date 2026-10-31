// @vitest-environment happy-dom
import React, { act } from 'react'
import type { DiffSectionItem } from '@/components/editor/DiffSectionItem'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { createRepoUpdateActions } from '@/store/repos/repo-update'
import type { RepoUpdate } from '@/store/repos/repo-state'
import { GHCommentComposer as PageComposer } from '@/components/pull-request-page/comments/composer'
import { GHCommentComposer as DialogComposer } from '../discuss-item/gh-comment-composer'
import { PRFilesCombinedDiffViewer as PageFiles } from '@/components/pull-request-page/files/combined-diff-viewer'
import { PRFilesCombinedDiffViewer as DialogFiles } from '../inspect-pull-request/pr-files-combined-diff-viewer'
import { useGitHubWorkItemDetails } from './use-github-work-item-details'
import {
  invalidateWorkItemDetailsCacheForKey,
  optimisticWorkItemComments,
  touchWorkItemDetailsCache,
  workItemDetailsCache,
  WORK_ITEM_DETAILS_CACHE_MAX,
  WORK_ITEM_DETAILS_FRESH_MS
} from './work-item-details-cache'
import type {
  GitHubWorkItem,
  GitHubWorkItemDetails
} from '../../../../../shared/github/work-item-types'
import type { Repo } from '../../../../../shared/repo-types'

const io = vi.hoisted(() => ({
  add: vi.fn(),
  viewed: vi.fn(),
  details: vi.fn(),
  update: vi.fn(),
  renders: new Map<string, number>()
}))
vi.mock('@/store', async () => {
  const { create } = await import('zustand')
  return {
    useAppStore: create(() => ({
      repos: [],
      settings: {},
      projects: [],
      projectHostSetups: [],
      folderWorkspacePathStatuses: {},
      recordFeatureInteraction: () => {}
    }))
  }
})
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('@/hooks/use-document-dark-theme', () => ({ useDocumentDarkTheme: () => false }))
vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: React.PropsWithChildren) => <>{children}</>,
  TooltipTrigger: ({ children }: React.PropsWithChildren) => <>{children}</>,
  TooltipContent: () => null
}))
vi.mock('@/components/ui/button', () => ({
  Button: ({
    size: _size,
    variant: _variant,
    ...props
  }: React.ComponentProps<'button'> & { size?: string; variant?: string }) => <button {...props} />
}))
vi.mock('@/components/github/GitHubMarkdownComposer', () => ({
  GitHubMarkdownComposer: ({
    value,
    onChange,
    disabled
  }: {
    value: string
    onChange: (value: string) => void
    disabled: boolean
  }) => (
    <textarea
      value={value}
      disabled={disabled}
      onInput={(event) => onChange(event.currentTarget.value)}
    />
  )
}))
vi.mock('@/components/pull-request-page/mentions/textarea', () => ({
  MentionTextarea: ({
    value,
    onValueChange
  }: {
    value: string
    onValueChange: (value: string) => void
  }) => <textarea value={value} onInput={(event) => onValueChange(event.currentTarget.value)} />
}))
// Replace layout/Monaco I/O only; the production viewer chooses file identity, pending and toggle admission.
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    measure: () => {},
    measureElement: () => {},
    getTotalSize: () => count * 80,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({ index, key: index, start: index * 80 })),
    scrollToIndex: () => {}
  })
}))
vi.mock('@/components/editor/DiffSectionItem', () => ({
  DiffSectionItem: ({
    section,
    renderHeaderTrailingContent
  }: React.ComponentProps<typeof DiffSectionItem>) => (
    <div>{renderHeaderTrailingContent?.(section, 0)}</div>
  )
}))
vi.mock('@/components/editor/combined-diff/browse-files/combined-diff-file-tree', () => ({
  CombinedDiffFileTree: () => null
}))
vi.mock('@/components/pull-request-page/files/toolbar', () => ({ PRFilesDiffToolbar: () => null }))
vi.mock('../inspect-pull-request/pr-files-combined-diff-toolbar', () => ({
  PRFilesCombinedDiffToolbar: () => null
}))
vi.mock('@/components/pull-request-page/files/view-restore', () => ({
  usePRFilesDiffViewPersistence: () => {}
}))
vi.mock('@/components/pull-request-page/files/section-loader', () => ({
  usePRFileSectionLoader: () => ({
    loadSection: () => {},
    retrySection: () => {},
    toggleSection: () => {},
    setAllSectionsCollapsed: () => {}
  })
}))

const repository = { owner: 'fork', repo: 'widgets', host: 'github.corp' }
function item(owner = 'fork'): GitHubWorkItem {
  return {
    id: 'pr:93',
    repoId: 'clone',
    type: 'pr',
    number: 93,
    title: owner,
    state: 'open',
    labels: [],
    author: null,
    updatedAt: '',
    url: `https://github.corp/${owner}/widgets/pull/93`,
    prRepo: { ...repository, owner }
  }
}
function full(opened: GitHubWorkItem): GitHubWorkItemDetails {
  return {
    item: opened,
    body: opened.title,
    comments: [],
    assignees: [],
    files: [
      {
        path: 'same.ts',
        additions: 1,
        deletions: 0,
        status: 'modified',
        isBinary: false,
        viewerViewedState: 'UNVIEWED'
      }
    ],
    checks: [],
    pullRequestId: `PR_${opened.title}`,
    headSha: 'head',
    baseSha: 'base'
  }
}
function row(user = 'A'): Repo {
  return {
    id: 'clone',
    path: '/clone',
    executionHostId: 'local',
    displayName: 'clone',
    badgeColor: '',
    addedAt: 0,
    ghAccount: { host: 'github.corp', user }
  }
}
const repoActions = createRepoUpdateActions(useAppStore.setState, useAppStore.getState)
async function account(user: string) {
  expect(
    await repoActions.updateRepo(
      'clone',
      { ghAccount: { host: 'github.corp', user } },
      { hostId: 'local' }
    )
  ).toBe(true)
}
const originItem = item()
const otherItem = item('upstream')
const NOW = Date.UTC(2026, 9, 31, 12)
const viewerKinds = ['page', 'dialog'] as const
type ViewerKind = (typeof viewerKinds)[number]
let root: ReturnType<typeof createRoot>
let container: HTMLDivElement
const views = new Map<string, ReturnType<typeof useGitHubWorkItemDetails>>()
function Surface({
  name,
  opened,
  composer,
  files
}: {
  name: string
  opened: GitHubWorkItem
  composer?: 'page' | 'dialog'
  files?: ViewerKind
}) {
  const view = useGitHubWorkItemDetails({
    workItem: opened,
    repoPath: '/clone',
    effectiveRepoId: 'clone'
  })
  views.set(name, view)
  io.renders.set(name, (io.renders.get(name) ?? 0) + 1)
  const Composer = composer === 'page' ? PageComposer : DialogComposer
  const Files = files === 'page' ? PageFiles : DialogFiles
  return (
    <section data-name={name}>
      <output>{view.details?.comments.map((comment) => comment.body).join(',')}</output>
      <output data-files>
        {view.details?.files?.map((file) => file.viewerViewedState).join(',')}
      </output>
      {composer && (
        <Composer
          key={`${opened.url}:${composer}`}
          repoPath="/clone"
          repoId="clone"
          issueNumber={93}
          itemType="pr"
          prRepo={opened.prRepo}
          mentionOptions={[]}
          onCommentAdded={view.appendOptimisticComment}
        />
      )}
      {files && (
        <Files
          files={view.details?.files ?? []}
          comments={[]}
          repoId="clone"
          repoPath="/clone"
          prNumber={93}
          prRepo={opened.prRepo}
          prUrl={opened.url}
          headSha="head"
          baseSha="base"
          pendingViewedPaths={view.pendingViewedPaths}
          onViewedChange={view.handlePRFileViewedChange}
          onCommentAdded={view.appendOptimisticComment}
        />
      )}
    </section>
  )
}
function FileObservers({
  viewer,
  showOrigin = true
}: {
  viewer: ViewerKind
  showOrigin?: boolean
}) {
  return (
    <>
      {showOrigin && <Surface key="files" name="files" opened={originItem} files={viewer} />}
      {showOrigin && <Surface key="observer" name="observer" opened={originItem} files={viewer} />}
      <Surface key="B" name="B" opened={otherItem} />
    </>
  )
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
function checkbox(name = 'files'): HTMLButtonElement {
  const element = container.querySelector<HTMLButtonElement>(
    `[data-name="${name}"] [role="checkbox"]`
  )
  if (!element) {
    throw new Error('missing rendered Viewed control')
  }
  return element
}
async function submit() {
  const input = container.querySelector('textarea')
  if (!input) {
    throw new Error('missing real composer input')
  }
  await act(async () => {
    input.value = 'confirmed origin'
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  const button = container.querySelector<HTMLButtonElement>('[aria-label="Send comment"]')
  if (!button || button.disabled) {
    throw new Error('composer cannot submit')
  }
  await act(async () => button.click())
}
beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0)
    return 0
  })
  workItemDetailsCache.clear()
  optimisticWorkItemComments.clear()
  views.clear()
  io.renders.clear()
  useAppStore.setState({
    repos: [row()],
    projects: [],
    projectHostSetups: [],
    folderWorkspacePathStatuses: {}
  })
  io.add.mockReset()
  io.viewed.mockReset()
  io.details.mockReset().mockImplementation(async (args) => full(item(args.ownerRepo.owner)))
  io.update.mockReset().mockImplementation(async ({ updates }: { updates: RepoUpdate }) => {
    const selected = useAppStore.getState().repos.find((repo) => repo.id === 'clone')
    if (!selected) {
      throw new Error('missing persisted clone')
    }
    return { ...selected, ...updates }
  })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      repos: { update: io.update },
      gh: {
        workItemDetails: io.details,
        addIssueComment: io.add,
        setPRFileViewed: io.viewed,
        notifyWorkItemMutated: async () => true
      }
    }
  })
  container = document.createElement('div')
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it.each(['page', 'dialog'] as const)(
  'real %s composer retains origin success through a pending production fetch, close/switch and late eviction',
  async (composer) => {
    const renderOrigin = () =>
      root.render(
        <>
          <Surface key="composer" name="A" opened={originItem} composer={composer} />
          <Surface key="observer" name="observer" opened={originItem} />
        </>
      )
    await act(async () => renderOrigin())
    const originKey = views.get('A')!.detailsCacheKey!
    await act(async () => root.render(null))
    touchWorkItemDetailsCache(originKey, {
      ...workItemDetailsCache.get(originKey)!,
      fetchedAt: NOW - WORK_ITEM_DETAILS_FRESH_MS - 1
    })
    const refresh = deferred<GitHubWorkItemDetails | null>()
    io.details.mockReturnValueOnce(refresh.promise)
    await act(async () => renderOrigin())
    expect(io.details).toHaveBeenCalledTimes(2)
    const pending = workItemDetailsCache.get(originKey)?.pending
    expect(pending).toBeDefined()
    expect(views.get('A')?.details?.body).toBe('fork')
    const answer = deferred<Awaited<ReturnType<typeof window.api.gh.addIssueComment>>>()
    io.add.mockReturnValueOnce(answer.promise)
    await submit()
    expect(io.add).toHaveBeenCalledWith(
      expect.objectContaining({ repoId: 'clone', prRepo: repository, body: 'confirmed origin' })
    )
    // The real composing component unmounts; the origin observer and real read remain alive.
    await act(async () =>
      root.render(
        <>
          <Surface key="B" name="B" opened={otherItem} />
          <Surface key="observer" name="observer" opened={originItem} />
        </>
      )
    )
    const beforeB = io.renders.get('B')
    const beforeReads = io.details.mock.calls.length
    const bSnapshot = views.get('B')?.details
    const comment = {
      id: 9001,
      body: 'confirmed origin',
      author: 'me',
      authorAvatarUrl: '',
      url: 'https://github.corp/fork/widgets/pull/93#issuecomment-9001',
      createdAt: ''
    }
    await act(async () => answer.resolve({ ok: true, comment }))
    expect(workItemDetailsCache.get(originKey)?.pending).toBe(pending)
    expect(container.querySelector('[data-name="observer"] output')?.textContent).toBe(
      'confirmed origin'
    )
    // Complete the actual dispatched lookup and production settler with provider-lagged comments.
    await act(async () => refresh.resolve(full(originItem)))
    expect(workItemDetailsCache.get(originKey)?.pending).toBeUndefined()
    expect(workItemDetailsCache.get(originKey)?.details?.comments).toEqual([])
    expect(container.querySelector('[data-name="observer"] output')?.textContent).toBe(
      'confirmed origin'
    )
    expect(views.get('B')?.details).toBe(bSnapshot)
    expect(container.querySelector('[data-name="B"] output')?.textContent).toBe('')
    expect(io.renders.get('B')).toBe(beforeB)
    expect(io.details).toHaveBeenCalledTimes(beforeReads)
    await act(async () => renderOrigin())
    expect(container.querySelector('[data-name="A"] output')?.textContent).toBe('confirmed origin')
    expect(
      container.querySelector<HTMLButtonElement>('[aria-label="Send comment"]')?.disabled
    ).toBe(true)
    // A fresh real submission can settle after capacity eviction without creating an optimistic-only orphan.
    const late = deferred<Awaited<ReturnType<typeof window.api.gh.addIssueComment>>>()
    io.add.mockReturnValueOnce(late.promise)
    await submit()
    await act(async () => root.render(<Surface key="B" name="B" opened={otherItem} />))
    await act(async () => evictOrigin(originKey))
    expect(workItemDetailsCache.has(originKey)).toBe(false)
    const freshComment = { ...comment, id: 9002, body: 'fresh origin' }
    await act(async () => late.resolve({ ok: true, comment: freshComment }))
    expect(io.add).toHaveBeenCalledTimes(2)
    expect(workItemDetailsCache.size).toBeLessThanOrEqual(WORK_ITEM_DETAILS_CACHE_MAX)
    expect(workItemDetailsCache.get(originKey)?.details).toBeNull()
    expect(optimisticWorkItemComments.get(originKey)).toEqual([freshComment])
    await act(async () => renderOrigin())
    expect(container.querySelector('[data-name="A"] output')?.textContent).toBe('fresh origin')
    expect(workItemDetailsCache.get(originKey)?.pending).toBeUndefined()
  }
)
it.each(['page', 'dialog'] as const)(
  'real %s composer does not append false/throw, releases live submit and permits explicit retry',
  async (composer) => {
    await act(async () => root.render(<Surface name="A" opened={item()} composer={composer} />))
    io.add.mockResolvedValueOnce({ ok: false, error: 'denied' })
    await submit()
    expect(
      container.querySelector<HTMLButtonElement>('[aria-label="Send comment"]')?.disabled
    ).toBe(false)
    expect(container.querySelector('output')?.textContent).toBe('')
    io.add.mockRejectedValueOnce(new Error('transport closed'))
    await submit()
    expect(
      container.querySelector<HTMLButtonElement>('[aria-label="Send comment"]')?.disabled
    ).toBe(false)
    io.add.mockResolvedValueOnce({
      ok: true,
      comment: { id: 2, body: 'retry', author: 'me', createdAt: '' }
    })
    await submit()
    expect(container.querySelector('output')?.textContent).toBe('retry')
  }
)
const outcomes = ['true', 'false', 'throw'] as const
async function settleViewed(
  answer: ReturnType<typeof deferred<boolean>>,
  outcome: (typeof outcomes)[number]
) {
  await act(async () =>
    outcome === 'throw' ? answer.reject(new Error('failed')) : answer.resolve(outcome === 'true')
  )
}
function evictOrigin(key: string) {
  // Keep the real origin's account/resource scope while filling the existing MRU with other PRs.
  const prefix = key.slice(0, key.lastIndexOf('\0') + 1)
  for (let index = 0; index < WORK_ITEM_DETAILS_CACHE_MAX + 1; index++) {
    const number = 1000 + index
    const opened = {
      ...originItem,
      id: `pr:${number}`,
      number,
      url: `https://github.corp/fork/widgets/pull/${number}`
    }
    touchWorkItemDetailsCache(`${prefix}${number}`, {
      details: full(opened),
      fetchedAt: NOW
    })
  }
}

for (const viewer of viewerKinds) {
  it.each(outcomes)(
    `${viewer} Viewed uses real account save A-B-A, drains off-current %s and completes a fresh press`,
    async (outcome) => {
      const answer = deferred<boolean>()
      io.viewed.mockReturnValueOnce(answer.promise)
      await act(async () => root.render(<FileObservers viewer={viewer} />))
      const aKey = views.get('files')!.detailsCacheKey!
      await act(async () => checkbox().click())
      expect(checkbox().disabled).toBe(true)
      expect(checkbox('observer').disabled).toBe(true)
      expect(io.viewed).toHaveBeenCalledWith(
        expect.objectContaining({
          prRepo: repository,
          pullRequestId: 'PR_fork',
          path: 'same.ts',
          viewed: true
        })
      )
      await act(async () => account('B'))
      expect(io.update).toHaveBeenLastCalledWith(
        expect.objectContaining({
          repoId: 'clone',
          hostId: 'local',
          updates: { ghAccount: { host: 'github.corp', user: 'B' } }
        })
      )
      expect(views.get('files')!.detailsCacheKey).not.toBe(aKey)
      expect(checkbox().getAttribute('aria-checked')).toBe('false')
      const bRenders = new Map(io.renders)
      const bSnapshot = views.get('files')?.details
      const bReads = io.details.mock.calls.length
      await settleViewed(answer, outcome)
      expect(io.renders).toEqual(bRenders)
      expect(views.get('files')?.details).toBe(bSnapshot)
      expect(io.details).toHaveBeenCalledTimes(bReads)
      expect(io.viewed).toHaveBeenCalledTimes(1)
      expect(workItemDetailsCache.get(aKey)?.viewed?.paths.size).toBe(0)
      await act(async () => account('A'))
      expect(io.update).toHaveBeenCalledTimes(2)
      expect(views.get('files')!.detailsCacheKey).toBe(aKey)
      const checked = outcome === 'true'
      expect(checkbox().disabled).toBe(false)
      expect(checkbox().getAttribute('aria-checked')).toBe(String(checked))
      expect(checkbox('observer').getAttribute('aria-checked')).toBe(String(checked))
      const unrelatedRenders = io.renders.get('B')
      const unrelatedSnapshot = views.get('B')?.details
      io.viewed.mockResolvedValueOnce(true)
      await act(async () => checkbox().click())
      expect(checkbox().disabled).toBe(false)
      expect(checkbox().getAttribute('aria-checked')).toBe(String(!checked))
      expect(checkbox('observer').getAttribute('aria-checked')).toBe(String(!checked))
      expect(io.viewed).toHaveBeenLastCalledWith(expect.objectContaining({ viewed: !checked }))
      expect(io.viewed).toHaveBeenCalledTimes(2)
      expect(io.renders.get('B')).toBe(unrelatedRenders)
      expect(views.get('B')?.details).toBe(unrelatedSnapshot)
      expect(io.details).toHaveBeenCalledTimes(bReads)
    }
  )

  for (const retirement of ['invalidation', 'eviction'] as const) {
    it.each(outcomes)(
      `${viewer} Viewed ${retirement}/replacement read protects a same-path successor from old %s`,
      async (outcome) => {
        const old = deferred<boolean>()
        const successor = deferred<boolean>()
        io.viewed.mockReturnValueOnce(old.promise).mockReturnValueOnce(successor.promise)
        await act(async () => root.render(<FileObservers viewer={viewer} />))
        const key = views.get('files')!.detailsCacheKey!
        await act(async () => checkbox().click())
        expect(checkbox('observer').disabled).toBe(true)
        const oldOwner = workItemDetailsCache.get(key)?.viewed
        const replacement = deferred<GitHubWorkItemDetails | null>()
        if (retirement === 'eviction') {
          await act(async () => root.render(<FileObservers viewer={viewer} showOrigin={false} />))
          await act(async () => evictOrigin(key))
          expect(workItemDetailsCache.has(key)).toBe(false)
          io.details.mockReturnValueOnce(replacement.promise)
          await act(async () => root.render(<FileObservers viewer={viewer} />))
        } else {
          io.details.mockReturnValueOnce(replacement.promise)
          await act(async () => invalidateWorkItemDetailsCacheForKey(key))
        }
        expect(workItemDetailsCache.get(key)?.pending).toBeDefined()
        expect(io.details).toHaveBeenLastCalledWith(
          expect.objectContaining({ ownerRepo: repository })
        )
        await act(async () => replacement.resolve(full(originItem)))
        expect(workItemDetailsCache.get(key)?.pending).toBeUndefined()
        expect(checkbox().disabled).toBe(false)
        await act(async () => checkbox().click())
        const replacementOwner = workItemDetailsCache.get(key)?.viewed
        expect(replacementOwner).not.toBe(oldOwner)
        expect(checkbox().disabled).toBe(true)
        expect(checkbox('observer').disabled).toBe(true)
        expect(checkbox().getAttribute('aria-checked')).toBe('true')
        const bRenders = io.renders.get('B')
        const bSnapshot = views.get('B')?.details
        const reads = io.details.mock.calls.length
        await settleViewed(old, outcome)
        expect(workItemDetailsCache.get(key)?.viewed).toBe(replacementOwner)
        expect(workItemDetailsCache.get(key)?.viewed?.paths.has('same.ts')).toBe(true)
        expect(oldOwner?.requests.size).toBe(0)
        expect(checkbox().disabled).toBe(true)
        expect(checkbox().getAttribute('aria-checked')).toBe('true')
        expect(checkbox('observer').disabled).toBe(true)
        expect(io.viewed).toHaveBeenCalledTimes(2)
        await act(async () => successor.resolve(true))
        expect(checkbox().disabled).toBe(false)
        expect(checkbox().getAttribute('aria-checked')).toBe('true')
        expect(checkbox('observer').disabled).toBe(false)
        io.viewed.mockResolvedValueOnce(true)
        await act(async () => checkbox().click())
        expect(checkbox().disabled).toBe(false)
        expect(checkbox().getAttribute('aria-checked')).toBe('false')
        expect(checkbox('observer').getAttribute('aria-checked')).toBe('false')
        expect(io.viewed).toHaveBeenCalledTimes(3)
        expect(io.renders.get('B')).toBe(bRenders)
        expect(views.get('B')?.details).toBe(bSnapshot)
        expect(io.details).toHaveBeenCalledTimes(reads)
      }
    )
  }

  it.each(['false', 'throw'] as const)(
    `${viewer} Viewed retains a newer production fetch answer when old mutation returns %s`,
    async (outcome) => {
      const old = deferred<boolean>()
      io.viewed.mockReturnValueOnce(old.promise)
      await act(async () => root.render(<FileObservers viewer={viewer} />))
      const key = views.get('files')!.detailsCacheKey!
      await act(async () => checkbox().click())
      const owner = workItemDetailsCache.get(key)?.viewed
      await act(async () => root.render(<FileObservers viewer={viewer} showOrigin={false} />))
      touchWorkItemDetailsCache(key, {
        ...workItemDetailsCache.get(key)!,
        fetchedAt: NOW - WORK_ITEM_DETAILS_FRESH_MS - 1
      })
      const refresh = deferred<GitHubWorkItemDetails | null>()
      io.details.mockReturnValueOnce(refresh.promise)
      await act(async () => root.render(<FileObservers viewer={viewer} />))
      expect(workItemDetailsCache.get(key)?.pending).toBeDefined()
      const source = full(originItem)
      source.files = source.files?.map((file) => ({
        ...file,
        viewerViewedState: 'VIEWED' as const
      }))
      await act(async () => refresh.resolve(source))
      expect(workItemDetailsCache.get(key)?.details).toBe(source)
      expect(workItemDetailsCache.get(key)?.viewed).toBe(owner)
      expect(checkbox().disabled).toBe(true)
      const beforeB = io.renders.get('B')
      const bSnapshot = views.get('B')?.details
      const reads = io.details.mock.calls.length
      await settleViewed(old, outcome)
      expect(workItemDetailsCache.get(key)?.details).toBe(source)
      expect(workItemDetailsCache.get(key)?.pending).toBeUndefined()
      expect(checkbox().disabled).toBe(false)
      expect(checkbox().getAttribute('aria-checked')).toBe('true')
      expect(checkbox('observer').getAttribute('aria-checked')).toBe('true')
      io.viewed.mockResolvedValueOnce(true)
      await act(async () => checkbox().click())
      expect(checkbox().getAttribute('aria-checked')).toBe('false')
      expect(checkbox().disabled).toBe(false)
      expect(checkbox('observer').disabled).toBe(false)
      expect(io.viewed).toHaveBeenCalledTimes(2)
      expect(io.renders.get('B')).toBe(beforeB)
      expect(views.get('B')?.details).toBe(bSnapshot)
      expect(io.details).toHaveBeenCalledTimes(reads)
    }
  )
}
