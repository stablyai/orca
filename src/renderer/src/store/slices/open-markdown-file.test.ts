// @vitest-environment happy-dom

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { toast } from 'sonner'
import { createTestStore, makeWorktree, TEST_REPO } from './store-test-helpers'

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    warning: vi.fn()
  }
}))

const wt1 = makeWorktree({ id: 'wt-1', repoId: TEST_REPO.id, path: '/repo1/wt1' })

function seedActiveWorktree(store: ReturnType<typeof createTestStore>): void {
  store.setState({
    repos: [TEST_REPO],
    worktreesByRepo: { [TEST_REPO.id]: [wt1] },
    activeWorktreeId: wt1.id
  })
}

describe('openMarkdownFileInActiveWorkspace', () => {
  beforeEach(() => {
    vi.mocked(toast.error).mockClear()
  })

  it('opens the picked file rooted at the active worktree path', async () => {
    const pickWorktreeMarkdownDocument = vi.fn().mockResolvedValue({
      filePath: '/repo1/wt1/notes.md',
      relativePath: 'notes.md'
    })
    globalThis.window.api = {
      app: { pickWorktreeMarkdownDocument }
    } as unknown as Window['api']

    const store = createTestStore()
    seedActiveWorktree(store)

    await store.getState().openMarkdownFileInActiveWorkspace('group-1')

    expect(pickWorktreeMarkdownDocument).toHaveBeenCalledWith(wt1.path)
    expect(store.getState().openFiles).toHaveLength(1)
    expect(store.getState().openFiles[0]).toMatchObject({
      filePath: '/repo1/wt1/notes.md',
      relativePath: 'notes.md',
      worktreeId: wt1.id,
      language: 'markdown',
      mode: 'edit'
    })
  })

  it('does nothing when the picker is cancelled', async () => {
    const pickWorktreeMarkdownDocument = vi.fn().mockResolvedValue(null)
    globalThis.window.api = {
      app: { pickWorktreeMarkdownDocument }
    } as unknown as Window['api']

    const store = createTestStore()
    seedActiveWorktree(store)

    await store.getState().openMarkdownFileInActiveWorkspace('group-1')

    expect(store.getState().openFiles).toHaveLength(0)
  })

  it('does nothing when there is no active worktree', async () => {
    const pickWorktreeMarkdownDocument = vi.fn()
    globalThis.window.api = {
      app: { pickWorktreeMarkdownDocument }
    } as unknown as Window['api']

    const store = createTestStore()
    store.setState({ repos: [TEST_REPO], activeWorktreeId: null })

    await store.getState().openMarkdownFileInActiveWorkspace('group-1')

    expect(pickWorktreeMarkdownDocument).not.toHaveBeenCalled()
    expect(store.getState().openFiles).toHaveLength(0)
  })

  it('guards remote worktrees instead of opening the local file dialog', async () => {
    const pickWorktreeMarkdownDocument = vi.fn()
    globalThis.window.api = {
      app: { pickWorktreeMarkdownDocument }
    } as unknown as Window['api']

    const store = createTestStore()
    const remoteRepo = { ...TEST_REPO, connectionId: 'conn-1' }
    store.setState({
      repos: [remoteRepo],
      worktreesByRepo: { [remoteRepo.id]: [wt1] },
      activeWorktreeId: wt1.id
    })

    await store.getState().openMarkdownFileInActiveWorkspace('group-1')

    expect(pickWorktreeMarkdownDocument).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalled()
    expect(store.getState().openFiles).toHaveLength(0)
  })

  it('shows a toast error when the picker rejects', async () => {
    const pickWorktreeMarkdownDocument = vi.fn().mockRejectedValue(new Error('boom'))
    globalThis.window.api = {
      app: { pickWorktreeMarkdownDocument }
    } as unknown as Window['api']

    const store = createTestStore()
    seedActiveWorktree(store)

    await store.getState().openMarkdownFileInActiveWorkspace('group-1')

    expect(toast.error).toHaveBeenCalledWith('boom')
    expect(store.getState().openFiles).toHaveLength(0)
  })
})
