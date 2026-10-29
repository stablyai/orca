import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildClientAutomationWorkspaceProvenance,
  CLIENT_PROVENANCE_SNAPSHOT_MAX
} from '../../../../shared/automation-workspace-provenance'
import { ClientAutomationWorkspaceProvenance } from '../../../../shared/rpc-contract/worktree-params'
import { WORKTREE_CLIENT_AUTOMATION_PROVENANCE_RUNTIME_CAPABILITY } from '../../../../shared/worktree-runtime-capabilities'
import {
  createCompatibleRuntimeStatusResponse,
  type RuntimeEnvironmentCallRequest
} from '../../runtime/runtime-compatibility-test-fixture'
import { makeAutomation } from '../../components/automations/automations-page-fixtures'
import { makeWorktree } from './worktrees-slice-test-fixtures'
import {
  createTestStore,
  resetRemoteRuntimeMocks,
  resetWorktreeSliceModuleMemory,
  runtimeEnvironmentCall,
  runtimeEnvironmentTransportCall
} from './worktrees-slice-test-harness'

vi.mock('sonner', () => ({
  toast: { warning: vi.fn(), info: vi.fn(), success: vi.fn(), error: vi.fn(), dismiss: vi.fn() }
}))

const REQUEST = {
  automationId: 'automation-1',
  automationRunId: 'run-1',
  dispatchToken: 'token-1',
  createRequestId: 'create-1'
}
const RECORD = {
  automationId: 'automation-1',
  automationNameSnapshot: 'Nightly review',
  automationRunId: 'run-1',
  automationRunTitleSnapshot: 'Nightly review run',
  executionTargetType: 'local' as const,
  executionTargetId: 'local',
  projectId: 'project-1',
  hostId: 'local' as const
}

beforeEach(() => {
  vi.clearAllMocks()
  resetRemoteRuntimeMocks()
  resetWorktreeSliceModuleMemory()
})

function createOnRuntimeHost(hostRecordsClientProvenance: boolean) {
  const status = createCompatibleRuntimeStatusResponse('runtime-remote')
  if (status.ok && !hostRecordsClientProvenance) {
    status.result.capabilities = status.result.capabilities?.filter(
      (cap) => cap !== WORKTREE_CLIENT_AUTOMATION_PROVENANCE_RUNTIME_CAPABILITY
    )
  }
  runtimeEnvironmentTransportCall.mockImplementation((args: RuntimeEnvironmentCallRequest) =>
    args.method === 'status.get' ? status : runtimeEnvironmentCall(args)
  )
  runtimeEnvironmentCall.mockResolvedValue({
    id: 'create',
    ok: true,
    result: { worktree: makeWorktree({ id: 'repo1::/path/feature', repoId: 'repo1' }) },
    _meta: { runtimeId: 'runtime-remote' }
  })
  const store = createTestStore()
  store.setState({ repos: [], worktreesByRepo: { repo1: [] } })
  const createWorktree = store.getState().createWorktree
  const args: Parameters<typeof createWorktree> = ['repo1', 'feature']
  args[25] = {
    executionHostId: 'runtime:env-1',
    automationProvenanceRequest: REQUEST,
    clientAutomationProvenance: RECORD
  }
  return createWorktree(...args)
}

function hostCreateParams(): unknown {
  return runtimeEnvironmentCall.mock.calls.find(([call]) => call.method === 'worktree.create')?.[0]
    .params
}

// #34433: a host cannot verify this desktop's token, so a capable host gets the run as a label instead.
describe('a desktop automation create on a runtime host', () => {
  it('sends a capable host its own run as a label, never the token', async () => {
    await createOnRuntimeHost(true)

    expect(hostCreateParams()).toMatchObject({ clientAutomationProvenance: RECORD })
    expect(hostCreateParams()).not.toHaveProperty('automationProvenanceRequest')
  })

  it('sends an older host neither the token nor the label', async () => {
    await createOnRuntimeHost(false)

    expect(hostCreateParams()).not.toHaveProperty('clientAutomationProvenance')
    expect(hostCreateParams()).not.toHaveProperty('automationProvenanceRequest')
  })
})

it('truncates long snapshots so a host keeps the label', () => {
  const name = 'n'.repeat(CLIENT_PROVENANCE_SNAPSHOT_MAX + 50)
  const label = buildClientAutomationWorkspaceProvenance(makeAutomation({ name }), {
    id: 'run-1',
    title: `${name} run 1`
  })

  expect(ClientAutomationWorkspaceProvenance.safeParse(label).success).toBe(true)
})
