// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import type { PtyListedSession } from '../../../shared/pty-listed-session'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { wakeSleepingAgentsForWorktreeInBackground } from './wake-sleeping-agents-in-background'
import { waitForWorktreeAgentActivationGateForTests } from './worktree-agent-activation-gate'

// Main's answer to the window's layout commands, as a switch-on build sends them.
vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)

const initialAppStoreState = useAppStore.getState()
const WT = 'repo-1::/repo'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const PANE_KEY = makePaneKey('tab-live', LEAF_ID)
const LIVE_PTY_ID = `${WT}@@66acae23`
const SESSION = {
  key: 'session_id',
  id: '720b368a-0168-4083-9f8c-862cd559ac51'
} as const

let listedSessions: PtyListedSession[] = []
let listSessions: ReturnType<typeof vi.fn>

function liveRecord(): SleepingAgentSessionRecord {
  return {
    paneKey: PANE_KEY,
    tabId: 'tab-live',
    worktreeId: WT,
    agent: 'claude',
    providerSession: SESSION,
    prompt: '',
    state: 'working',
    origin: 'live',
    capturedAt: Date.now(),
    updatedAt: Date.now()
  }
}

// The host renderer restarted while its daemon PTY survived: the tab and its persisted layout are
// there, but nothing reattached the pane, and the user is looking at another worktree.
function unmountedLivePaneState(): Partial<AppState> {
  return {
    workspaceSessionReady: true,
    terminalStartupRestorationReady: true,
    activeWorktreeId: 'repo-1::/other',
    repos: [
      {
        id: 'repo-1',
        path: '/repo',
        displayName: 'repo',
        badgeColor: '#000',
        addedAt: 1
      }
    ],
    tabsByWorktree: {
      [WT]: [
        {
          id: 'tab-live',
          ptyId: null,
          worktreeId: WT,
          title: 'Terminal 1',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    ptyIdsByTabId: {},
    terminalLayoutsByTabId: {
      'tab-live': {
        root: { type: 'leaf', leafId: LEAF_ID },
        activeLeafId: LEAF_ID,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF_ID]: LIVE_PTY_ID }
      }
    },
    sleepingAgentSessionsByPaneKey: { [PANE_KEY]: liveRecord() }
  }
}

async function wakeAndSettle(): Promise<string | null> {
  wakeSleepingAgentsForWorktreeInBackground(WT)
  return waitForWorktreeAgentActivationGateForTests(WT)
}

function queuedResumes(): unknown[] {
  return Object.values(useAppStore.getState().pendingStartupByTabId).map(
    (startup) => startup.resumeProviderSession
  )
}

beforeEach(() => {
  listedSessions = []
  listSessions = vi.fn(async () => listedSessions)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the wake path reads only these preload methods.
  ;(window as unknown as { api: unknown }).api = {
    pty: { listSessions },
    runtimeEnvironments: {},
    runtime: {
      call: vi.fn(async ({ method }: { method: string }) =>
        method === 'session.tabs.list'
          ? { ok: true, result: { worktree: WT, tabs: [] } }
          : { ok: false }
      )
    }
  }
})

afterEach(() => {
  useAppStore.setState(initialAppStoreState, true)
})

describe('background wake of a pane whose PTY the host still holds', () => {
  it('does not resume a second writer onto the live conversation', async () => {
    useAppStore.setState(unmountedLivePaneState())
    listedSessions = [
      {
        id: LIVE_PTY_ID,
        cwd: '/repo',
        title: 'claude',
        agentOwnership: 'present'
      }
    ]

    await wakeAndSettle()

    expect(listSessions).toHaveBeenCalledWith({ connectionId: null })
    expect(queuedResumes()).toEqual([])
    expect(Object.keys(useAppStore.getState().automaticAgentResumeClaimsByTabId)).toEqual([])
  })

  it('declines the resume and keeps the record when the host inventory cannot be read', async () => {
    useAppStore.setState(unmountedLivePaneState())
    listSessions.mockRejectedValue(new Error('daemon unreachable'))

    expect(await wakeAndSettle()).toBe('blocked')

    expect(queuedResumes()).toEqual([])
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[PANE_KEY]).toBeDefined()
  })

  it('still resumes once the host inventory shows the PTY exited', async () => {
    useAppStore.setState(unmountedLivePaneState())

    expect(await wakeAndSettle()).toBe('resumed')

    expect(queuedResumes()).toEqual([SESSION])
  })
})
