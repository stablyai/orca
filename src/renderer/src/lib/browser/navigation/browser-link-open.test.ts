import { expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  browserTabsByWorktree: {},
  browserPagesByWorkspace: {},
  createBrowserTab: (): never => {
    throw new Error('tab refused for https://example.com/?token=fixture-secret')
  }
}))
vi.mock('@/store/index', () => ({
  useAppStore: { getState: () => state, subscribe: () => () => {} }
}))
vi.mock('@/store', () => ({ useAppStore: { getState: () => state } }))
vi.mock('./browser-link-destination', async (load) => ({
  ...(await load<object>()),
  selectBrowserLinkDestination: () => ({ status: 'create', match: null })
}))
vi.mock('./browser-link-owner', () => ({ createBrowserLinkHostMatcher: () => () => true }))
vi.mock('./browser-link-reveal', () => ({
  captureBrowserLinkReveal: () => ({ canReveal: () => true, dispose: () => {} })
}))

const { openLocalBrowserLink } = await import('./browser-link-open')

it("a desktop tab the store refuses reports a create failure, not a bare 'failed'", async () => {
  const outcome = await openLocalBrowserLink({
    destination: {
      worktreeId: 'wt',
      executionHostId: 'local',
      browserRuntimeEnvironmentId: null,
      profileHostId: 'local',
      sessionProfileId: null,
      sessionPartition: null,
      resource: { kind: 'website', url: 'https://example.com/' }
    },
    context: { linkIntent: null },
    url: 'https://example.com/',
    ownsRoute: () => true
  })
  expect(outcome).toEqual({ status: 'failed', cause: 'client-create-rejected' })
})
