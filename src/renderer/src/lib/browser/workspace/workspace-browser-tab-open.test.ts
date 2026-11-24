import { expect, it, vi } from 'vitest'

vi.mock('@/store/index', () => ({ useAppStore: { getState: () => ({}) } }))
vi.mock('@/store', () => ({ useAppStore: { getState: () => ({}) } }))
// A workspace on paired runtime env-1 whose host refuses the create, as a stale profile would.
vi.mock('../../workspace/creation/surface-policy/client-creation-action-policy', async (load) => ({
  ...(await load<object>()),
  getClientCreationActionPolicy: vi.fn(() => ({
    'managed-browser': { state: 'enabled', provider: 'paired-runtime' }
  }))
}))
vi.mock('../../workspace/ownership/worktree-operation-route', async (load) => ({
  ...(await load<object>()),
  getFloatingWorkspaceOperationRoute: () => null,
  resolveWorktreeOperationRoute: () => ({
    executionHostId: 'runtime:env-1',
    runtimeEnvironmentId: 'env-1'
  })
}))
vi.mock('@/runtime/browser/creation/web-runtime-browser-client-target-group', () => ({
  resolveWebRuntimeBrowserClientTargetGroup: () => ({})
}))
vi.mock('@/runtime/browser/creation/web-runtime-browser-creation', () => ({
  createWebRuntimeSessionBrowserTab: async (args: {
    onFailure?: (info: { stage: string; code: string | null }) => void
  }) => {
    args.onFailure?.({ stage: 'create', code: 'invalid_argument' })
    return false
  }
}))

const { openWorkspaceBrowserTab } = await import('./workspace-browser-tab-open')
const { openWorkspaceBrowserTabForLink } = await import('./workspace-browser-tab-open-for-link')
const { openFailureDetail } = await import('./workspace-browser-tab-presentation')

it('a clicked link that fails keeps its reason for the toast', async () => {
  const opening = openWorkspaceBrowserTabForLink({
    workspaceId: 'wt',
    url: 'not a url',
    intent: { kind: 'url' },
    linkContext: { linkIntent: null, isCurrentRequest: () => true }
  })
  const error = await opening.then(
    () => null,
    (reason: unknown) => reason
  )
  expect(error).toMatchObject({ display: { kind: 'not-web-link' } })
  expect(openFailureDetail(error)).not.toBeNull()
})

it('a click superseded while its open was failing stays silent', async () => {
  // Current when the open starts, stale by the time it fails.
  let checks = 0
  await expect(
    openWorkspaceBrowserTabForLink({
      workspaceId: 'wt',
      url: 'not a url',
      intent: { kind: 'url' },
      linkContext: { linkIntent: null, isCurrentRequest: () => checks++ === 0 }
    })
  ).resolves.toEqual({ status: 'superseded' })
})

it("a paired host's refusal reaches the toast with its stage and code", async () => {
  const error = await openWorkspaceBrowserTab({
    workspaceId: 'wt',
    url: 'https://example.com/page',
    intent: { kind: 'url' }
  }).then(
    () => null,
    (reason: unknown) => reason
  )
  const detail = openFailureDetail(error)
  expect(detail).toContain('create')
  expect(detail).toContain('invalid_argument')
})

it('a policy-refused open still names its cause', async () => {
  const { getClientCreationActionPolicy } =
    await import('../../workspace/creation/surface-policy/client-creation-action-policy')
  vi.mocked(getClientCreationActionPolicy).mockReturnValueOnce({
    'managed-browser': { state: 'hidden', reason: 'Managed browser tabs are unavailable.' },
    'mobile-emulator': { state: 'hidden', reason: 'Mobile Emulator is unavailable.' }
  })
  const error = await openWorkspaceBrowserTab({
    workspaceId: 'wt',
    url: 'https://example.com/page',
    intent: { kind: 'url' }
  }).then(
    () => null,
    (reason: unknown) => reason
  )
  expect(openFailureDetail(error)).toContain('browser_unavailable')
})
