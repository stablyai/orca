// @vitest-environment happy-dom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { ALL_EXECUTION_HOSTS_SCOPE, type ExecutionHostId } from '../../../../shared/execution-host'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { LocalCapacitySignal } from '../../../../shared/local-capacity-signal-types'
import type { Project, ProjectHostSetup } from '../../../../shared/project-types'
import type { Repo } from '../../../../shared/repo-types'
import type { RuntimeEnvironmentStatus } from '../../../../shared/runtime-host-status'
import type { RuntimeStatus } from '../../../../shared/runtime-session-contracts'
import type { SshConnectionState } from '../../../../shared/ssh-types'
import type { ProjectHostSetupOption } from '@/lib/project-host-setup-options'
import { resolveWorkspaceCreationTarget } from '@/lib/project-host-workspace-target'
import { useRunnerDefaultTarget } from './runner-default-target'

type RunnerDefaultTargetInput = Parameters<typeof useRunnerDefaultTarget>[0]

const PROJECT_ID = 'p1'
const REPO_ID = 'orca'
const SSH_TARGET_ID = 'builder'
const SSH_HOST: ExecutionHostId = `ssh:${SSH_TARGET_ID}`
const RUNTIME_ENVIRONMENT_ID = 'env-1'
const RUNTIME_HOST: ExecutionHostId = `runtime:${RUNTIME_ENVIRONMENT_ID}`

// Why: the live arm's status is never read by the suggestion; only the verdict is.
const LIVE_RUNTIME_STATUS: RuntimeStatus = {
  runtimeId: 'runtime-1',
  rendererGraphEpoch: 0,
  graphStatus: 'ready',
  authoritativeWindowId: null,
  liveTabCount: 0,
  liveLeafCount: 0
}

const ON_BATTERY_AND_LOW_MEMORY: LocalCapacitySignal = {
  onBattery: true,
  lowMemory: true,
  lowCpu: false,
  reasons: ['on battery', 'low memory']
}

const getLocalCapacitySignal = vi.fn<() => Promise<LocalCapacitySignal>>()

function makeRepo(id: string, overrides: Partial<Repo> = {}): Repo {
  return {
    id,
    path: `/repos/${id}`,
    displayName: id,
    badgeColor: '#000000',
    addedAt: 1,
    ...overrides
  }
}

function makeProject(id: string, sourceRepoIds: string[]): Project {
  return {
    id,
    displayName: id,
    badgeColor: '#000000',
    sourceRepoIds,
    createdAt: 1,
    updatedAt: 1
  }
}

function makeSetup(id: string, hostId: ExecutionHostId, repoId: string): ProjectHostSetup {
  return {
    id,
    projectId: PROJECT_ID,
    hostId,
    repoId,
    path: `/repos/${repoId}`,
    displayName: repoId,
    setupState: 'ready',
    setupMethod: 'legacy-repo',
    createdAt: 1,
    updatedAt: 1
  }
}

function readyOption(hostId: ExecutionHostId, repoId: string): ProjectHostSetupOption {
  return {
    id: `${hostId}-${repoId}`,
    kind: 'ready',
    projectId: PROJECT_ID,
    hostId,
    repoId,
    label: repoId,
    detail: '',
    path: `/repos/${repoId}`
  }
}

function connectedSshState(): Map<string, SshConnectionState> {
  return new Map([
    [
      SSH_TARGET_ID,
      { targetId: SSH_TARGET_ID, status: 'connected', error: null, reconnectAttempt: 0 }
    ]
  ])
}

function liveRunnerStatus(): Map<string, RuntimeEnvironmentStatus> {
  return new Map([[RUNTIME_ENVIRONMENT_ID, { status: LIVE_RUNTIME_STATUS, checkedAt: 0 }]])
}

function weakSettings(): GlobalSettings {
  return { ...getDefaultSettings('/tmp'), preferRunnerWhenLocalWeak: true }
}

type Scenario = {
  repos: Repo[]
  projects: Project[]
  projectHostSetups: ProjectHostSetup[]
  hostOptions: ProjectHostSetupOption[]
  sshConnectionStates: ReadonlyMap<string, SshConnectionState>
  runtimeStatusByEnvironmentId: ReadonlyMap<string, RuntimeEnvironmentStatus>
}

/** The same repo on the local host and on a connected SSH runner. */
function sameRepoOnLocalAndSsh(): Scenario {
  const setups = [
    makeSetup('local-setup', 'local', REPO_ID),
    makeSetup('ssh-setup', SSH_HOST, REPO_ID)
  ]
  return {
    repos: [makeRepo(REPO_ID), makeRepo(REPO_ID, { connectionId: SSH_TARGET_ID })],
    projects: [makeProject(PROJECT_ID, [REPO_ID])],
    projectHostSetups: setups,
    hostOptions: setups.map((setup) => readyOption(setup.hostId, setup.repoId)),
    sshConnectionStates: connectedSshState(),
    runtimeStatusByEnvironmentId: new Map()
  }
}

function createInput(
  scenario: Scenario,
  overrides: Partial<RunnerDefaultTargetInput> = {}
): RunnerDefaultTargetInput {
  // Why: built the way the composer builds it — the base target is what creation resolves to
  // before the suggestion, from the same inputs the hook receives.
  const baseTarget = resolveWorkspaceCreationTarget({
    eligibleRepos: scenario.repos,
    projects: scenario.projects,
    projectHostSetups: scenario.projectHostSetups,
    draftRepoId: overrides.repoId ?? REPO_ID,
    projectHostSetupId: overrides.selectedProjectHostSetupOverrideId ?? null,
    focusedHostScope: overrides.workspaceHostScope ?? ALL_EXECUTION_HOSTS_SCOPE
  })
  return {
    settings: weakSettings(),
    hostOptions: scenario.hostOptions,
    sshConnectionStates: scenario.sshConnectionStates,
    runtimeStatusByEnvironmentId: scenario.runtimeStatusByEnvironmentId,
    selectedProjectHostSetupOverrideId: null,
    workspaceHostScope: ALL_EXECUTION_HOSTS_SCOPE,
    baseTarget,
    eligibleRepos: scenario.repos,
    projects: scenario.projects,
    projectHostSetups: scenario.projectHostSetups,
    repoId: REPO_ID,
    ...overrides
  }
}

// Why: the sample arrives through a promise; without the flush a "no causes" assertion could pass
// because the signal never landed rather than because the guard held.
async function renderRunner(input: RunnerDefaultTargetInput) {
  const rendered = renderHook((props: RunnerDefaultTargetInput) => useRunnerDefaultTarget(props), {
    initialProps: input
  })
  await waitFor(() => expect(getLocalCapacitySignal).toHaveBeenCalled())
  await act(async () => {
    await Promise.resolve()
  })
  return rendered
}

// Why assign, not stubGlobal: replacing window would drop the happy-dom document renderHook needs.
const previousApi = window.api

describe('useRunnerDefaultTarget', () => {
  beforeEach(() => {
    getLocalCapacitySignal.mockReset()
    getLocalCapacitySignal.mockResolvedValue(ON_BATTERY_AND_LOW_MEMORY)
    Object.assign(window, { api: { notifications: { getLocalCapacitySignal } } })
  })

  afterEach(() => {
    cleanup()
    Object.assign(window, { api: previousApi })
  })

  it('moves a weak machine to a live runner and carries the causes', async () => {
    const input = createInput(sameRepoOnLocalAndSsh())
    const { result } = await renderRunner(input)

    expect(input.baseTarget).toMatchObject({ status: 'ready', target: { hostId: 'local' } })
    expect(result.current.target).toMatchObject({
      status: 'ready',
      target: { hostId: SSH_HOST, repoId: REPO_ID }
    })
    expect(result.current.causes).toEqual(['onBattery', 'lowMemory'])
  })

  it("keeps the user's explicit run target, however weak the machine looks", async () => {
    // Why: same scenario as the test above, minus the explicit choice — so a null here is the
    // guard and not a signal that never arrived.
    const input = createInput(sameRepoOnLocalAndSsh(), {
      selectedProjectHostSetupOverrideId: 'local-setup'
    })
    const { result } = await renderRunner(input)

    expect(input.baseTarget).toMatchObject({
      status: 'ready',
      target: { projectHostSetupId: 'local-setup' }
    })
    expect(result.current.target).toEqual(input.baseTarget)
    expect(result.current.causes).toBeNull()
  })

  it('never reroutes while the host scope is focused', async () => {
    // Why: a focused scope is the user narrowing the host list to the local host; a live SSH
    // runner outside it must not pull the target away.
    const input = createInput(sameRepoOnLocalAndSsh(), { workspaceHostScope: 'local' })
    const { result } = await renderRunner(input)

    expect(input.baseTarget).toMatchObject({ status: 'ready', target: { hostId: 'local' } })
    expect(result.current.target).toEqual(input.baseTarget)
    expect(result.current.causes).toBeNull()
  })

  it('keeps the base target when the suggested runner would change the repo', async () => {
    const sourceRepoIds = ['orca-local', 'orca-ssh']
    const setups = [
      makeSetup('local-setup', 'local', 'orca-local'),
      makeSetup('ssh-setup', SSH_HOST, 'orca-ssh')
    ]
    const input = createInput(
      {
        repos: [makeRepo('orca-local'), makeRepo('orca-ssh', { connectionId: SSH_TARGET_ID })],
        projects: [makeProject(PROJECT_ID, sourceRepoIds)],
        projectHostSetups: setups,
        hostOptions: setups.map((setup) => readyOption(setup.hostId, setup.repoId)),
        sshConnectionStates: connectedSshState(),
        runtimeStatusByEnvironmentId: new Map()
      },
      { repoId: 'orca-local' }
    )
    const { result } = await renderRunner(input)

    expect(input.baseTarget).toMatchObject({
      status: 'ready',
      target: { hostId: 'local', repoId: 'orca-local' }
    })
    expect(result.current.target).toEqual(input.baseTarget)
    expect(result.current.causes).toBeNull()
  })

  it('claims no cause when the base target is already on the runner', async () => {
    const setups = [makeSetup('ssh-setup', SSH_HOST, REPO_ID)]
    const input = createInput({
      repos: [makeRepo(REPO_ID, { connectionId: SSH_TARGET_ID })],
      projects: [makeProject(PROJECT_ID, [REPO_ID])],
      projectHostSetups: setups,
      hostOptions: setups.map((setup) => readyOption(setup.hostId, setup.repoId)),
      sshConnectionStates: connectedSshState(),
      runtimeStatusByEnvironmentId: new Map()
    })
    const { result } = await renderRunner(input)

    expect(input.baseTarget).toMatchObject({ status: 'ready', target: { hostId: SSH_HOST } })
    expect(result.current.target).toEqual(input.baseTarget)
    expect(result.current.causes).toBeNull()
  })

  it('prefers a live paired server over a connected SSH target', async () => {
    const scenario = sameRepoOnLocalAndSsh()
    const setups = [
      ...scenario.projectHostSetups,
      makeSetup('runtime-setup', RUNTIME_HOST, REPO_ID)
    ]
    const input = createInput({
      ...scenario,
      repos: [...scenario.repos, makeRepo(REPO_ID, { executionHostId: RUNTIME_HOST })],
      projectHostSetups: setups,
      hostOptions: setups.map((setup) => readyOption(setup.hostId, setup.repoId)),
      runtimeStatusByEnvironmentId: liveRunnerStatus()
    })
    const { result } = await renderRunner(input)

    expect(result.current.target).toMatchObject({
      status: 'ready',
      target: { hostId: RUNTIME_HOST, repoId: REPO_ID }
    })
    expect(result.current.causes).toEqual(['onBattery', 'lowMemory'])
  })

  it('reads the capacity sample once per mount, not per re-render', async () => {
    const input = createInput(sameRepoOnLocalAndSsh())
    const { result, rerender } = await renderRunner(input)

    expect(result.current.causes).toEqual(['onBattery', 'lowMemory'])

    // Why: a fresh settings object per render is the real caller's shape, so a per-object dep
    // would re-sample the machine on every keystroke in the composer.
    rerender({ ...input, settings: weakSettings() })
    rerender({ ...input, settings: weakSettings() })

    expect(getLocalCapacitySignal).toHaveBeenCalledTimes(1)
  })
})
