import { beforeEach, expect, it, vi } from 'vitest'
import { LOCAL_EXECUTION_HOST_ID, toRuntimeExecutionHostId } from '../../../shared/execution-host'
import { createVoiceSidebarSession } from './voice-sidebar-session'
import { useVoiceSidebarSessions } from './voice-sidebar-state'

const fakes = vi.hoisted(() => ({ launch: vi.fn(), plan: vi.fn(() => ({})) }))
vi.mock('@/store', () => ({ useAppStore: { getState: () => ({}) } }))
vi.mock('@/lib/agent-session-launch-plan', () => ({ planAgentSessionLaunch: fakes.plan }))
vi.mock('@/lib/agent-launch-route-input', () => ({
  worktreeLaunchWorkspace: (worktreeId: string) => ({ worktreeId })
}))
vi.mock('@/lib/agent-launch-request-id', () => ({ newAgentLaunchRequestId: () => 'request' }))
vi.mock('@/lib/agent-session/structured-agent-session-provisional-tab', () => ({
  beginStructuredAgentSessionProvisionalLaunch: fakes.launch
}))
vi.mock('@/runtime/structured-agent-session-owner', () => ({
  resolveStructuredAgentSessionOwner: vi.fn()
}))

beforeEach(() => {
  vi.clearAllMocks()
  useVoiceSidebarSessions.setState({ entries: {}, portal: null })
})

it('deduplicates a pending New chat click and retains an uncertain launch for recovery', async () => {
  let settle: (result: { kind: 'visibility-unknown'; sessionId: string }) => void = () => {}
  fakes.launch.mockReturnValue({
    settlement: new Promise((resolve) => {
      settle = resolve
    })
  })
  const first = createVoiceSidebarSession('local-folder', 'folder', LOCAL_EXECUTION_HOST_ID)
  await createVoiceSidebarSession('local-folder', 'folder', LOCAL_EXECUTION_HOST_ID)
  expect(fakes.launch).toHaveBeenCalledTimes(1)
  expect(fakes.launch).toHaveBeenCalledWith(
    expect.objectContaining({ activate: true, hooks: { activate: true } })
  )
  settle({ kind: 'visibility-unknown', sessionId: 'uncertain' })
  await first
  expect(fakes.launch).toHaveBeenCalledTimes(1)
  expect(useVoiceSidebarSessions.getState().entries['local-folder']).toMatchObject({
    status: 'ready',
    session: { sessionId: 'uncertain' }
  })
})

it('keeps conversations on their captured execution host when the same folder exists remotely', async () => {
  fakes.launch.mockReturnValueOnce({
    settlement: Promise.resolve({ kind: 'structured', sessionId: 'local' })
  })
  fakes.launch.mockReturnValueOnce({
    settlement: Promise.resolve({ kind: 'structured', sessionId: 'remote' })
  })
  const remote = toRuntimeExecutionHostId('paired-host')
  await createVoiceSidebarSession('local-folder', 'folder', LOCAL_EXECUTION_HOST_ID)
  await createVoiceSidebarSession('remote-folder', 'folder', remote)
  expect(fakes.plan).toHaveBeenLastCalledWith(
    {},
    expect.objectContaining({ selectedExecutionHostId: remote })
  )
  expect(useVoiceSidebarSessions.getState().entries['local-folder']).toMatchObject({
    session: { executionHostId: LOCAL_EXECUTION_HOST_ID, sessionId: 'local' }
  })
  expect(useVoiceSidebarSessions.getState().entries['remote-folder']).toMatchObject({
    session: { executionHostId: remote, sessionId: 'remote' }
  })
})
