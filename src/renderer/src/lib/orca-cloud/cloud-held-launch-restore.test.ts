// @vitest-environment happy-dom
// V3-01: a held Orca Cloud launch survives a quit. Its placeholder is remembered (per profile), and
// on the next start the hold is put back once the placeholder tab returns: the strip's key and the
// original prompt come back, Start launches it, Cancel forgets it, and nothing launches unasked.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { CreateWebRuntimeSessionTerminalOnHostArgs } from '@/runtime/hosted-terminals/creation/terminal-create-contracts'

const mocks = vi.hoisted(() => {
  const state: {
    coverage: 'notSetUp' | 'covered' | 'expired'
    /** 'loading' with a failing read: Orca couldn't check the sign-in. */
    load: 'ready' | 'loading'
    closed: string[]
    listeners: Set<() => void>
  } = {
    coverage: 'notSetUp',
    load: 'ready',
    closed: [],
    listeners: new Set()
  }
  return state
})

vi.mock('./orca-cloud-environment-id', () => ({
  isOrcaCloudEnvironmentId: () => true,
  isOrcaCloudExecutionHostId: () => true
}))
vi.mock('./orca-cloud-agent-accounts-store', () => ({
  readOrcaCloudAgentAccounts: () => ({ load: { kind: mocks.load }, keyKinds: {} }),
  ensureFreshOrcaCloudAgentAccounts: async () => {
    if (mocks.load === 'loading') {
      throw new Error('read failed')
    }
    return { load: { kind: 'ready' }, keyKinds: {} }
  },
  isOrcaCloudAgentAccountsFresh: () => true,
  subscribeOrcaCloudAgentAccounts: (listener: () => void) => {
    mocks.listeners.add(listener)
    return () => mocks.listeners.delete(listener)
  }
}))
vi.mock('./orca-cloud-agent-accounts-model', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  orcaCloudAgentCoverageFromAccounts: () => ({
    kind:
      mocks.coverage === 'covered'
        ? 'account'
        : mocks.coverage === 'expired'
          ? 'expired'
          : 'notSetUp'
  })
}))
vi.mock('@/runtime/web-session-tabs-sync/actions/web-runtime-session-tab-lifecycle', () => ({
  closeWebRuntimeSessionTab: async (args: { tabId: string }) => {
    mocks.closed.push(args.tabId)
  }
}))
vi.mock('@/runtime/hosted-terminals/creation/web-runtime-terminal-create-operation', () => ({
  createWebRuntimeSessionTerminalResult: vi.fn()
}))

const { cloudTabHoldKey, readCloudAgentHold, releaseCloudAgentHold } =
  await import('./cloud-agent-launch-hold')
const { createWithCloudAgentHold } = await import('./cloud-web-host-launch-hold')
const { readHeldCloudLaunches, rememberHeldCloudLaunch } =
  await import('./cloud-held-launch-memory')
const { resumeHeldCloudLaunches, resetHeldCloudLaunchResumeForTest } =
  await import('./cloud-held-launch-resume')

const ENV = 'env-cloud'
const WT = 'repo::/ws'
const HOST_TAB = 'host-tab-1'
const TAB = 'web-terminal-host-tab-1'

function setTabs(ids: string[]): void {
  useAppStore.setState({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hold reads only tab ids.
    tabsByWorktree: { [WT]: ids.map((id) => ({ id })) } as never
  })
}

const created = (hostTabId: string) => ({
  outcome: { status: 'created' as const },
  hostTabId
})

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  localStorage.clear()
  mocks.coverage = 'notSetUp'
  mocks.closed = []
  mocks.load = 'ready'
  mocks.listeners.clear()
  resetHeldCloudLaunchResumeForTest()
  useAppStore.setState({ activeOrcaProfileId: 'profile-a' })
  setTabs([])
})
afterEach(() => {
  for (const key of [cloudTabHoldKey(TAB)]) {
    if (readCloudAgentHold(key)) {
      releaseCloudAgentHold(key, 'cancel')
    }
  }
  vi.useRealTimers()
})

describe('a held launch is remembered', () => {
  it('records the placeholder with agent and prompt, and forgets it once Start launches it', async () => {
    const create = vi.fn(async (args: CreateWebRuntimeSessionTerminalOnHostArgs) =>
      args.agent || args.launchAgent ? created('host-agent') : created(HOST_TAB)
    )
    setTabs([TAB])
    const launch = createWithCloudAgentHold(
      { worktreeId: WT, environmentId: ENV, agent: 'claude', prompt: 'fix the test' },
      create
    )
    await flush()
    expect(readHeldCloudLaunches(ENV)).toMatchObject([
      { tabId: TAB, agent: 'claude', prompt: 'fix the test', worktreeId: WT }
    ])
    releaseCloudAgentHold(cloudTabHoldKey(TAB), 'proceed')
    await launch
    expect(readHeldCloudLaunches(ENV)).toEqual([])
  })

  it('is per profile: another profile never reads it', () => {
    rememberHeldCloudLaunch({
      environmentId: ENV,
      worktreeId: WT,
      tabId: TAB,
      agent: 'claude',
      prompt: null,
      cwd: null,
      targetGroupId: null,
      createdAt: Date.now()
    })
    useAppStore.setState({ activeOrcaProfileId: 'profile-b' })
    expect(readHeldCloudLaunches(ENV)).toEqual([])
    useAppStore.setState({ activeOrcaProfileId: 'profile-a' })
    expect(readHeldCloudLaunches(ENV)).toHaveLength(1)
  })
})

describe('after a restart', () => {
  const remember = () =>
    rememberHeldCloudLaunch({
      environmentId: ENV,
      worktreeId: WT,
      tabId: TAB,
      agent: 'claude',
      prompt: 'fix the test',
      cwd: '/ws',
      targetGroupId: null,
      createdAt: Date.now()
    })

  it('puts the hold back once the placeholder returns; Start launches the original prompt', async () => {
    remember()
    const create = vi.fn(async () => created('host-agent'))
    resumeHeldCloudLaunches(ENV, { create, waitMs: 5_000 })
    await flush()
    expect(readCloudAgentHold(cloudTabHoldKey(TAB))).toBeNull()
    setTabs([TAB])
    await flush()
    await flush()
    expect(readCloudAgentHold(cloudTabHoldKey(TAB))).toMatchObject({
      agent: 'claude',
      reason: 'notSetUp',
      prompt: 'fix the test'
    })
    expect(create).not.toHaveBeenCalled()
    releaseCloudAgentHold(cloudTabHoldKey(TAB), 'proceed')
    await flush()
    await flush()
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ agent: 'claude', prompt: 'fix the test', worktreeId: WT })
    )
    expect(mocks.closed).toEqual([TAB])
    expect(readHeldCloudLaunches(ENV)).toEqual([])
  })

  it('an account that is covered now waits for Start, as awaitingStart (never "not set up")', async () => {
    mocks.coverage = 'covered'
    remember()
    setTabs([TAB])
    const create = vi.fn(async () => created('host-agent'))
    resumeHeldCloudLaunches(ENV, { create, waitMs: 5_000 })
    await flush()
    await flush()
    expect(readCloudAgentHold(cloudTabHoldKey(TAB))).toMatchObject({
      reason: 'awaitingStart',
      awaiting: 'covered'
    })
    expect(create).not.toHaveBeenCalled()
  })

  it('a sign-in read that fails after restart waits as unread, never "not set up"', async () => {
    mocks.load = 'loading'
    remember()
    setTabs([TAB])
    const create = vi.fn(async () => created('host-agent'))
    resumeHeldCloudLaunches(ENV, { create, waitMs: 5_000 })
    await flush()
    await flush()
    expect(readCloudAgentHold(cloudTabHoldKey(TAB))).toMatchObject({
      reason: 'awaitingStart',
      awaiting: 'unread'
    })
    expect(create).not.toHaveBeenCalled()
  })

  it('restored and expired: a Renew turns it awaitingStart and starts nothing', async () => {
    mocks.coverage = 'expired'
    remember()
    setTabs([TAB])
    const create = vi.fn(async () => created('host-agent'))
    resumeHeldCloudLaunches(ENV, { create, waitMs: 5_000 })
    await flush()
    await flush()
    expect(readCloudAgentHold(cloudTabHoldKey(TAB))?.reason).toBe('accountExpired')
    mocks.coverage = 'covered'
    for (const listener of mocks.listeners) {
      listener()
    }
    await flush()
    expect(readCloudAgentHold(cloudTabHoldKey(TAB))).toMatchObject({
      reason: 'awaitingStart',
      awaiting: 'renewed'
    })
    expect(create).not.toHaveBeenCalled()
  })

  it('an expired hold whose sign-in is removed (not renewed) never starts: it becomes the setup', async () => {
    mocks.coverage = 'expired'
    setTabs([TAB])
    const create = vi.fn(async (args: CreateWebRuntimeSessionTerminalOnHostArgs) =>
      args.agent ? created('host-agent') : created(HOST_TAB)
    )
    void createWithCloudAgentHold(
      { worktreeId: WT, environmentId: ENV, agent: 'claude', prompt: 'p' },
      create
    )
    await flush()
    expect(readCloudAgentHold(cloudTabHoldKey(TAB))?.reason).toBe('accountExpired')
    mocks.coverage = 'notSetUp'
    for (const listener of mocks.listeners) {
      listener()
    }
    await flush()
    expect(readCloudAgentHold(cloudTabHoldKey(TAB))?.reason).toBe('notSetUp')
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('in-session (not restored), an expired hold still starts on Renew as before', async () => {
    mocks.coverage = 'expired'
    setTabs([TAB])
    const create = vi.fn(async (args: CreateWebRuntimeSessionTerminalOnHostArgs) =>
      args.agent ? created('host-agent') : created(HOST_TAB)
    )
    const launch = createWithCloudAgentHold(
      { worktreeId: WT, environmentId: ENV, agent: 'claude', prompt: 'p' },
      create
    )
    await flush()
    expect(readCloudAgentHold(cloudTabHoldKey(TAB))?.reason).toBe('accountExpired')
    mocks.coverage = 'covered'
    for (const listener of mocks.listeners) {
      listener()
    }
    await launch
    expect(create).toHaveBeenLastCalledWith(expect.objectContaining({ agent: 'claude' }))
  })

  it('Cancel forgets the record and launches nothing', async () => {
    remember()
    setTabs([TAB])
    const create = vi.fn(async () => created('host-agent'))
    resumeHeldCloudLaunches(ENV, { create, waitMs: 5_000 })
    await flush()
    await flush()
    releaseCloudAgentHold(cloudTabHoldKey(TAB), 'cancel')
    await flush()
    expect(create).not.toHaveBeenCalled()
    expect(readHeldCloudLaunches(ENV)).toEqual([])
  })

  it('a placeholder that never comes back is dropped after the bounded wait', async () => {
    vi.useFakeTimers()
    remember()
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    resumeHeldCloudLaunches(ENV, { create: vi.fn(), waitMs: 1_000 })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(readHeldCloudLaunches(ENV)).toEqual([])
    expect(info).toHaveBeenCalledWith(expect.stringContaining('held launch dropped'))
    info.mockRestore()
  })

  it('waits for the profile before reading the records', async () => {
    remember()
    setTabs([TAB])
    useAppStore.setState({ activeOrcaProfileId: null })
    const create = vi.fn(async () => created('host-agent'))
    resumeHeldCloudLaunches(ENV, { create, waitMs: 5_000 })
    await flush()
    expect(readCloudAgentHold(cloudTabHoldKey(TAB))).toBeNull()
    useAppStore.setState({ activeOrcaProfileId: 'profile-a' })
    await flush()
    await flush()
    expect(readCloudAgentHold(cloudTabHoldKey(TAB))).not.toBeNull()
  })
})
