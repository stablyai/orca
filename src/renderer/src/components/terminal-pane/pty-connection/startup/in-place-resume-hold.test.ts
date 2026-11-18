// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { resumeSleepingAgentSessionsForWorktree } from '@/lib/agent-session/resume/resume-sleeping-agent-session'
import type { ConnectPanePtySession } from '../connect-pane-pty-session'
import { armPaneOwnerRetry } from '../host-ownership/pane-owner-recovery'
import { runPaneResumeAttempt } from './in-place-resume-hold'
import { holdPaneResumeInPlace } from '../../session-restore/spawn-deferral/pane-spawn-deferral-registry'

vi.mock('@/runtime/rpc/calls/runtime-rpc-call', async (importOriginal) =>
  (
    await import('@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)

const initialState = useAppStore.getState()
const leafId = '11111111-1111-4111-8111-111111111111'
const sessions: ConnectPanePtySession[] = []

function createSession(): ConnectPanePtySession {
  const transport = { retryRecovery: undefined }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the ownership and retry seams only read the session members supplied here.
  const session = {
    cacheKey: `tab:${leafId}`,
    disposed: false,
    waitTeardowns: [],
    transportStreamGeneration: 1,
    runtimeEnvironmentId: null,
    paneStartup: {
      launchAgent: 'claude',
      resumeProviderSession: { key: 'session_id', id: '01a006a6-1d07-70a1-bad5-f9110d5845c0' }
    },
    pane: { id: 1, terminal: { write: vi.fn() } },
    transport,
    deps: {
      tabId: 'tab',
      worktreeId: 'worktree',
      isVisibleRef: { current: false },
      paneTransportsRef: { current: new Map([[1, transport]]) }
    }
  } as unknown as ConnectPanePtySession
  sessions.push(session)
  return session
}

function openWorkspace(): string[] {
  useAppStore.setState({ activeWorktreeId: 'worktree' })
  resumeSleepingAgentSessionsForWorktree('worktree')
  return useAppStore.getState().tabsByWorktree.worktree.map((tab) => tab.id)
}

beforeEach(() => {
  useAppStore.setState({
    activeWorktreeId: 'other-worktree',
    tabsByWorktree: {
      worktree: [
        {
          id: 'tab',
          worktreeId: 'worktree',
          ptyId: null,
          title: 'Claude',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    unifiedTabsByWorktree: {
      worktree: [
        {
          id: 'tab',
          contentType: 'terminal',
          entityId: 'tab',
          groupId: 'group',
          sortOrder: 0,
          worktreeId: 'worktree',
          label: 'Claude',
          customLabel: null,
          color: null,
          createdAt: 1
        }
      ]
    },
    ptyIdsByTabId: {},
    terminalLayoutsByTabId: {
      tab: {
        root: { type: 'leaf', leafId },
        activeLeafId: leafId,
        expandedLeafId: null,
        ptyIdsByLeafId: {}
      }
    },
    sleepingAgentSessionsByPaneKey: {
      [`tab:${leafId}`]: {
        paneKey: `tab:${leafId}`,
        tabId: 'tab',
        worktreeId: 'worktree',
        agent: 'claude',
        providerSession: { key: 'session_id', id: '01a006a6-1d07-70a1-bad5-f9110d5845c0' },
        prompt: 'continue the task',
        state: 'working',
        capturedAt: 1,
        updatedAt: 1,
        origin: 'quit',
        launchConfig: { agentCommand: 'claude', agentArgs: '', agentEnv: {} }
      }
    }
  })
})

afterEach(() => {
  for (const session of sessions.splice(0)) {
    session.disposed = true
    while (session.waitTeardowns.length) {
      session.waitTeardowns.pop()?.()
    }
  }
  useAppStore.setState(initialState, true)
})

it('keeps Retry in the original tab while its replacement is connecting', async () => {
  const session = createSession()
  await runPaneResumeAttempt(session, () => Promise.resolve(null))
  const connecting = Promise.withResolvers<string | null>()
  armPaneOwnerRetry(session, 1, () => runPaneResumeAttempt(session, () => connecting.promise))

  session.transport.retryRecovery?.()

  expect(openWorkspace()).toEqual(['tab'])
  connecting.resolve(null)
  await connecting.promise
})

it('allows activation recovery after a settled refusal and declines its stale Retry', async () => {
  const session = createSession()
  await runPaneResumeAttempt(session, () => Promise.resolve(null))
  const tabs = openWorkspace()
  expect(tabs).toHaveLength(2)
  const recoveredTab = tabs.find((id) => id !== 'tab')
  expect(recoveredTab).toBeDefined()
  armPaneOwnerRetry(session, 1, () => {
    throw new Error('a stale Retry must not start another writer')
  })

  session.transport.retryRecovery?.()

  expect(openWorkspace()).toEqual(tabs)
})

it('keeps successor ownership after disposal and late predecessor settlement', async () => {
  const predecessor = createSession()
  const oldAttempt = Promise.withResolvers<string | null>()
  void runPaneResumeAttempt(predecessor, () => oldAttempt.promise)
  predecessor.disposed = true
  while (predecessor.waitTeardowns.length) {
    predecessor.waitTeardowns.pop()?.()
  }
  const successor = createSession()
  const nextAttempt = Promise.withResolvers<string | null>()
  void runPaneResumeAttempt(successor, () => nextAttempt.promise)

  oldAttempt.resolve(null)
  await oldAttempt.promise
  expect(openWorkspace()).toEqual(['tab'])
  nextAttempt.resolve(null)
  await nextAttempt.promise
  expect(openWorkspace()).toHaveLength(2)
})

it('allows activation recovery after synchronous start failure', () => {
  const session = createSession()
  expect(() =>
    runPaneResumeAttempt(session, () => {
      throw new Error('start failed')
    })
  ).toThrow('start failed')
  expect(openWorkspace()).toHaveLength(2)
})

it('cannot release a successor handoff through a late attempt with updated dependencies', async () => {
  const predecessor = createSession()
  const releaseOriginal = holdPaneResumeInPlace(predecessor.cacheKey, () => true)
  predecessor.deps.releaseResumeInPlace = releaseOriginal
  const oldAttempt = Promise.withResolvers<string | null>()
  void runPaneResumeAttempt(predecessor, () => oldAttempt.promise)
  predecessor.disposed = true
  while (predecessor.waitTeardowns.length) {
    predecessor.waitTeardowns.pop()?.()
  }
  releaseOriginal()
  const releaseSuccessor = holdPaneResumeInPlace(predecessor.cacheKey, () => true)
  predecessor.deps.releaseResumeInPlace = releaseSuccessor
  try {
    oldAttempt.resolve(null)
    await oldAttempt.promise
    expect(openWorkspace()).toEqual(['tab'])
  } finally {
    releaseSuccessor()
  }
  expect(openWorkspace()).toHaveLength(2)
})
