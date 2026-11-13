// @vitest-environment happy-dom
// V3-01b: a held structured chat on Orca Cloud keeps its hold across a quit. Its record (per profile)
// lets startup put the hold back as soon as the chat's tab returns, whatever becomes of the launch's
// retry; the retry joins that hold; Start launches once, Cancel abandons; nothing is created on a
// failed or covered read after restart; in-session launches are unchanged.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useAppStore } from '@/store'
import type * as LaunchModule from '@/lib/agent-session/launch/structured-agent-session-launch'

const mocks = vi.hoisted(() => {
  const state: {
    coverage: 'notSetUp' | 'covered'
    load: 'ready' | 'loading'
    retried: string[]
    cancelled: string[]
    /** A read that hangs until released (accounts still loading at startup). */
    pendingRead: { resolve: () => void } | null
  } = { coverage: 'notSetUp', load: 'ready', retried: [], cancelled: [], pendingRead: null }
  return state
})

vi.mock('./orca-cloud-environment-id', () => ({
  isOrcaCloudEnvironmentId: () => true,
  isOrcaCloudEnvironmentForLaunch: async () => true,
  isOrcaCloudExecutionHostId: () => true
}))
vi.mock('./orca-cloud-agent-accounts-store', () => ({
  readOrcaCloudAgentAccounts: () => ({ load: { kind: mocks.load }, keyKinds: {} }),
  ensureFreshOrcaCloudAgentAccounts: async () => {
    if (mocks.pendingRead) {
      await new Promise<void>((resolve) => {
        mocks.pendingRead = { resolve }
      })
    }
    if (mocks.load === 'loading') {
      throw new Error('read failed')
    }
    return { load: { kind: 'ready' }, keyKinds: {} }
  },
  isOrcaCloudAgentAccountsFresh: () => mocks.load === 'ready',
  subscribeOrcaCloudAgentAccounts: () => () => undefined
}))
vi.mock('./orca-cloud-agent-accounts-model', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  orcaCloudAgentCoverageFromAccounts: () => ({
    kind: mocks.coverage === 'covered' ? 'account' : 'notSetUp'
  })
}))
vi.mock('@/lib/agent-session/launch/structured-agent-session-launch', async (importOriginal) => ({
  ...(await importOriginal<typeof LaunchModule>()),
  retryStructuredAgentSessionLaunch: (_worktreeId: string, sessionId: string) => {
    mocks.retried.push(sessionId)
    return true
  },
  cancelStructuredAgentLaunch: (_worktreeId: string, sessionId: string) => {
    mocks.cancelled.push(sessionId)
    return true
  }
}))
vi.mock('@/runtime/hosted-terminals/creation/web-runtime-terminal-create-operation', () => ({
  createWebRuntimeSessionTerminalResult: vi.fn()
}))

const { readCloudAgentHold, releaseCloudAgentHold } = await import('./cloud-agent-launch-hold')
const { holdStructuredCloudLaunch, structuredCloudHoldKey, useCloudHeldChatUnavailable } =
  await import('./cloud-structured-launch-hold')
const { readHeldStructuredLaunch, rememberHeldStructuredLaunch } =
  await import('./cloud-structured-held-launch-memory')
const { resumeHeldCloudLaunches, resetHeldCloudLaunchResumeForTest } =
  await import('./cloud-held-launch-resume')

const ENV = 'env-cloud'
const WT = 'repo::/ws'
const SESSION = 'claude_aaaa_bbbb'
const KEY = structuredCloudHoldKey(SESSION)
const intent = {
  sessionId: SESSION,
  worktreeId: WT,
  executionHostId: `runtime:${ENV}` as const,
  agent: 'claude'
}

function setChatOpen(open: boolean): void {
  useAppStore.setState({
    unifiedTabsByWorktree: {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the resume reads only contentType and entityId.
      [WT]: (open
        ? [
            {
              id: `structured-agent-session-${SESSION}`,
              contentType: 'agent-session',
              entityId: SESSION
            }
          ]
        : []) as never
    }
  })
}

const remember = () =>
  rememberHeldStructuredLaunch({
    sessionId: SESSION,
    worktreeId: WT,
    environmentId: ENV,
    agent: 'claude',
    createdAt: Date.now()
  })

const flush = async () => {
  for (let i = 0; i < 4; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

beforeEach(() => {
  localStorage.clear()
  mocks.coverage = 'notSetUp'
  mocks.load = 'ready'
  mocks.retried = []
  mocks.cancelled = []
  mocks.pendingRead = null
  resetHeldCloudLaunchResumeForTest()
  useAppStore.setState({ activeOrcaProfileId: 'profile-a' })
  setChatOpen(false)
})
afterEach(() => {
  if (readCloudAgentHold(KEY)) {
    releaseCloudAgentHold(KEY, 'cancel')
  }
})

describe('in session (no restart): unchanged', () => {
  it('a covered account starts at once, with no hold and no record', async () => {
    mocks.coverage = 'covered'
    await expect(holdStructuredCloudLaunch(intent)).resolves.toBe('proceed')
    expect(readCloudAgentHold(KEY)).toBeNull()
    expect(readHeldStructuredLaunch(SESSION)).toBeNull()
  })

  it('a held chat is remembered while held and forgotten once Start settles it', async () => {
    const held = holdStructuredCloudLaunch(intent)
    await flush()
    expect(readCloudAgentHold(KEY)?.reason).toBe('notSetUp')
    expect(readHeldStructuredLaunch(SESSION)).not.toBeNull()
    releaseCloudAgentHold(KEY, 'proceed')
    await expect(held).resolves.toBe('proceed')
    expect(readHeldStructuredLaunch(SESSION)).toBeNull()
  })
})

describe('after a restart', () => {
  it('puts the hold back as soon as the chat returns, before any retry', async () => {
    remember()
    resumeHeldCloudLaunches(ENV, { waitMs: 5_000 })
    await flush()
    expect(readCloudAgentHold(KEY)).toBeNull()
    setChatOpen(true)
    await flush()
    expect(readCloudAgentHold(KEY)?.reason).toBe('notSetUp')
  })

  it('with no retry joined, Start retries the launch once; Cancel abandons it', async () => {
    remember()
    setChatOpen(true)
    resumeHeldCloudLaunches(ENV, { waitMs: 5_000 })
    await flush()
    releaseCloudAgentHold(KEY, 'proceed')
    await flush()
    expect(mocks.retried).toEqual([SESSION])
    remember()
    resumeHeldCloudLaunches(ENV, { waitMs: 5_000 })
    await flush()
    releaseCloudAgentHold(KEY, 'cancel')
    await flush()
    expect(mocks.cancelled).toEqual([SESSION])
    expect(readHeldStructuredLaunch(SESSION)).toBeNull()
  })

  it('the launch retry joins the restored hold: one Start settles both, no second launch', async () => {
    remember()
    setChatOpen(true)
    resumeHeldCloudLaunches(ENV, { waitMs: 5_000 })
    await flush()
    const joined = holdStructuredCloudLaunch(intent)
    releaseCloudAgentHold(KEY, 'proceed')
    await expect(joined).resolves.toBe('proceed')
    await flush()
    expect(mocks.retried).toEqual([])
  })

  it('a retry that runs first, on a failed read, holds as awaitingStart (never proceeds)', async () => {
    remember()
    mocks.load = 'loading'
    const launch = holdStructuredCloudLaunch(intent)
    await flush()
    expect(readCloudAgentHold(KEY)).toMatchObject({ reason: 'awaitingStart', awaiting: 'unread' })
    let settled = false
    void launch.then(() => {
      settled = true
    })
    await flush()
    expect(settled).toBe(false)
  })

  it('a chat that never comes back is dropped after the bounded wait', async () => {
    vi.useFakeTimers()
    remember()
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    resumeHeldCloudLaunches(ENV, { waitMs: 1_000 })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(readHeldStructuredLaunch(SESSION)).toBeNull()
    expect(info).toHaveBeenCalledWith(expect.stringContaining('held chat dropped'))
    info.mockRestore()
    vi.useRealTimers()
  })
})

describe('races and marks', () => {
  it('startup and the retry asking at once (read still pending) share one hold; one Start settles both', async () => {
    remember()
    setChatOpen(true)
    mocks.pendingRead = { resolve: () => undefined }
    resumeHeldCloudLaunches(ENV, { waitMs: 5_000 })
    await flush()
    const retry = holdStructuredCloudLaunch(intent)
    mocks.pendingRead.resolve()
    await flush()
    expect(readCloudAgentHold(KEY)?.reason).toBe('notSetUp')
    releaseCloudAgentHold(KEY, 'proceed')
    await expect(retry).resolves.toBe('proceed')
    await flush()
    // The joined retry launches; startup doesn't launch it a second time.
    expect(mocks.retried).toEqual([])
  })

  it('an in-session join leaves no mark: a later restored hold still retries on Start', async () => {
    const first = holdStructuredCloudLaunch(intent)
    await flush()
    const second = holdStructuredCloudLaunch(intent)
    releaseCloudAgentHold(KEY, 'cancel')
    await Promise.all([first, second])
    remember()
    setChatOpen(true)
    resumeHeldCloudLaunches(ENV, { waitMs: 5_000 })
    await flush()
    releaseCloudAgentHold(KEY, 'proceed')
    await flush()
    expect(mocks.retried).toEqual([SESSION])
  })
})

describe('the generic sign-in notice', () => {
  const verdict = { reason: 'notSignedIn' }

  it('gives way to the strip only while the chat is held on Orca Cloud', async () => {
    const held = holdStructuredCloudLaunch(intent)
    await flush()
    expect(
      renderHook(() => useCloudHeldChatUnavailable(SESSION, verdict)).result.current
    ).toBeNull()
    releaseCloudAgentHold(KEY, 'cancel')
    await held
    expect(renderHook(() => useCloudHeldChatUnavailable(SESSION, verdict)).result.current).toBe(
      verdict
    )
  })

  it('a held chat still says a missing agent (only the sign-in verdict gives way)', async () => {
    const held = holdStructuredCloudLaunch(intent)
    await flush()
    const missing = { reason: 'cliMissing' }
    expect(renderHook(() => useCloudHeldChatUnavailable(SESSION, missing)).result.current).toBe(
      missing
    )
    releaseCloudAgentHold(KEY, 'cancel')
    await held
  })

  it('a chat that is not held (any host) keeps the generic notice', () => {
    expect(
      renderHook(() => useCloudHeldChatUnavailable('claude_other', verdict)).result.current
    ).toBe(verdict)
  })
})
