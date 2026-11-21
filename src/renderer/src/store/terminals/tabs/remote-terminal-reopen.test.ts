import type * as WorkspaceOwner from '@/lib/workspace/ownership/resolve-owner'
import type * as Environment from '@/runtime/web-session-tabs-sync/identity/web-runtime-session-environment'
import { expect, it, vi } from 'vitest'
import { createTestStore } from '../../testing/app-store-test-fixture'
import { createWebRuntimeSessionTerminalOnHost } from '@/runtime/hosted-terminals/creation/web-runtime-terminal-creation'
import { matchesWebSessionIntentOwner } from '@/runtime/web-session-tabs-sync/identity/web-runtime-session-environment'

vi.mock('@/runtime/hosted-terminals/creation/web-runtime-terminal-creation', () => ({
  createWebRuntimeSessionTerminalOnHost: vi.fn()
}))

vi.mock('@/lib/workspace/ownership/resolve-owner', async (importOriginal) => ({
  ...(await importOriginal<typeof WorkspaceOwner>()),
  runtimeEnvironmentIdForWorkspaceOwner: () => ({ kind: 'resolved', environmentId: 'paired' })
}))

vi.mock(
  '@/runtime/web-session-tabs-sync/identity/web-runtime-session-environment',
  async (importOriginal) => ({
    ...(await importOriginal<typeof Environment>()),
    matchesWebSessionIntentOwner: vi.fn()
  })
)

it('retains the remote tab on refusal and removes only its own entry after a successful retry', async () => {
  const store = createTestStore()
  const id = '829dd9ee-ec73-4067-9ac9-e1e52fdd3cdc'
  const remote = { environmentId: 'paired', pairingRevision: 8, mutationId: id }
  store.setState({
    recentlyClosedTabKindsByWorktree: { project: [{ remoteTerminalId: id }, 'editor'] },
    recentlyClosedTerminalTabsByWorktree: { project: [{ remote, startupCwd: '/work/demo' }] }
  })
  const reopen = () => store.getState().reopenClosedTab('project')
  vi.mocked(matchesWebSessionIntentOwner).mockReturnValue(false)
  expect(reopen()).toBe(false)
  expect(store.getState().recentlyClosedTabKindsByWorktree.project).toEqual([
    { remoteTerminalId: id },
    'editor'
  ])

  vi.mocked(matchesWebSessionIntentOwner).mockReturnValue(true)
  const started = Promise.withResolvers<void>()
  const response = Promise.withResolvers<{ status: 'created' }>()
  vi.mocked(createWebRuntimeSessionTerminalOnHost).mockImplementation(async (request) => {
    expect(request.environmentId).toBe('paired')
    expect(request.cwd).toBe('/work/demo')
    expect(request.reopen?.mutationId).toBe(id)
    started.resolve()
    return response.promise
  })
  expect(reopen()).toBe(true)
  expect(reopen()).toBe(false)
  await started.promise
  store.setState({
    recentlyClosedTabKindsByWorktree: { project: ['browser', { remoteTerminalId: id }, 'editor'] }
  })
  response.resolve({ status: 'created' })
  await vi.waitFor(() =>
    expect(store.getState().recentlyClosedTabKindsByWorktree.project).toEqual(['browser', 'editor'])
  )
})
