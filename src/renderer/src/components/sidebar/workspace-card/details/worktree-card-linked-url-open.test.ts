import { expect, it, vi } from 'vitest'

const toastError = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({ toast: { error: toastError } }))
vi.mock('@/store/index', () => ({ useAppStore: { getState: () => ({}) } }))
vi.mock('@/store', () => ({ useAppStore: { getState: () => ({}) } }))
vi.mock('@/lib/browser/workspace/workspace-browser-tab-open', async () => {
  const { openFailure } = await import('@/lib/browser/workspace/workspace-browser-tab-presentation')
  return {
    openWorkspaceBrowserTab: async () => {
      throw openFailure('Unable to open URL.', 'remote browser open failed', undefined, {
        kind: 'host-error',
        stage: 'create',
        code: 'invalid_argument'
      })
    }
  }
})

const { openLinkedUrlInWorkspaceBrowser } = await import('./worktree-card-linked-url-open')

it("the card's linked review that fails to open shows the cause under the toast title", async () => {
  await openLinkedUrlInWorkspaceBrowser('wt', 'https://github.com/org/repo/pull/1')

  const [title, options] = toastError.mock.calls[0]
  expect(title).toBe('Unable to open URL.')
  expect(options.description).toContain('create')
  expect(options.description).toContain('invalid_argument')
  expect(options.description).not.toContain('github.com')
})
