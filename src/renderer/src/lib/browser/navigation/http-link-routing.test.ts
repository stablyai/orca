import { expect, it, vi } from 'vitest'

const toastError = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({ toast: { error: toastError } }))
vi.mock('@/store/index', () => ({ useAppStore: { getState: () => ({}) } }))
vi.mock('@/store', () => ({ useAppStore: { getState: () => ({}) } }))

const { openOwnedHttpLink, registerHttpLinkStoreAccessor, registerWorkspaceHttpLinkBrowserOpener } =
  await import('./http-link-routing')
const { openFailure } = await import('../workspace/workspace-browser-tab-presentation')

it("a remote link's failed open shows the cause under the toast title", async () => {
  registerHttpLinkStoreAccessor(() => ({
    settings: { openLinksInApp: true },
    activeView: 'terminal',
    setActiveWorktree: () => {},
    createBrowserTab: () => undefined
  }))
  registerWorkspaceHttpLinkBrowserOpener(async () => {
    throw openFailure('Unable to open URL.', 'remote browser open failed', undefined, {
      kind: 'host-error',
      stage: 'create',
      code: 'invalid_argument'
    })
  })

  openOwnedHttpLink('https://github.com/org/repo/pull/1', {
    worktreeId: 'wt',
    sourceOwner: { kind: 'runtime', runtimeEnvironmentId: 'env-1' },
    allowRemoteInApp: true,
    forceInApp: true
  })

  await vi.waitFor(() => expect(toastError).toHaveBeenCalled())
  const [title, options] = toastError.mock.calls[0]
  expect(title).toBe('Unable to open URL.')
  expect(options.description).toContain('invalid_argument')
  expect(options.description).not.toContain('github.com')
})
