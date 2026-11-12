import { afterEach, describe, expect, it, vi } from 'vitest'
import { Terminal } from '@xterm/headless'
import { holdForStoppedWslDistro } from '../spawn/wsl-distro-stopped-hold-pane'
import {
  startHeldPanesForWslDistro,
  wslDistroStoppedHoldStore
} from '../../session-restore/wsl-distro/wsl-distro-stopped-hold-state'
import {
  acceptRetainedTerminalHistory,
  readSavedTerminalHistory
} from './retained-terminal-history'
import type { ConnectPanePtySession } from '../connect-pane-pty-session'
import { replaceRuntimeEnvironmentRevisions } from '@/runtime/rpc/environment-revisions/runtime-environment-revision'
import { createTestStore, seedStore } from '@/store/testing/app-store-test-fixture'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import { TEST_REPO } from '@/store/repos/repo.test-fixture'

const calls = vi.hoisted(
  (): { store: ReturnType<typeof createTestStore> | null } & Record<
    'rpc' | 'proof',
    ReturnType<typeof vi.fn>
  > => ({
    rpc: vi.fn(),
    proof: vi.fn(),
    store: null
  })
)
vi.mock('@/store/index', () => ({
  useAppStore: {
    getState: () => calls.store!.getState(),
    setState: (...args: Parameters<ReturnType<typeof createTestStore>['setState']>) =>
      calls.store!.setState(...args),
    subscribe: (...args: Parameters<ReturnType<typeof createTestStore>['subscribe']>) =>
      calls.store!.subscribe(...args)
  }
}))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({ callRuntimeRpc: calls.rpc }))
vi.mock('@/runtime/rpc/compatibility/runtime-capability-proof', () => ({
  runtimeEnvironmentCapabilityProof: calls.proof
}))
const disposables: Terminal[] = []
afterEach(() => {
  for (const terminal of disposables.splice(0)) {
    terminal.dispose()
  }
  wslDistroStoppedHoldStore.setState({ panes: {} })
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  replaceRuntimeEnvironmentRevisions([])
})

function fixture(environmentId: string | null = null) {
  if (environmentId) {
    replaceRuntimeEnvironmentRevisions([{ id: environmentId, createdAt: 12 }])
  }
  const terminal = new Terminal({ cols: 80, rows: 8, allowProposedApi: true })
  disposables.push(terminal)
  const transport = { getPtyId: () => null }
  const leafId = '9300e770-619b-46a9-b648-f31d85641c19'
  calls.store = createTestStore()
  seedStore(calls.store, {
    repos: [{ ...TEST_REPO, id: 'repo', path: '/bare', executionHostId: 'local' }],
    worktreesByRepo: {
      repo: [makeWorktree({ id: 'repo::/bare', repoId: 'repo', path: '/bare', hostId: 'local' })]
    },
    tabsByWorktree: {
      'repo::/bare': [
        {
          id: 'saved-tab',
          worktreeId: 'repo::/bare',
          ptyId: 'saved-shell',
          title: 'Terminal',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 0
        }
      ]
    },
    terminalLayoutsByTabId: {
      'saved-tab': {
        root: { type: 'leaf', leafId },
        activeLeafId: leafId,
        expandedLeafId: null,
        ptyIdsByLeafId: { [leafId]: 'saved-shell' }
      }
    }
  })
  const fields = {
    pane: { id: 1, leafId, terminal },
    transport,
    disposed: false,
    transportStreamGeneration: 1,
    tabGeneration: 0,
    runtimeEnvironmentId: environmentId,
    executionHostId: environmentId ? 'runtime:host' : 'local',
    terminalHistoryReadOwner: { environmentId, pairingRevision: environmentId ? 12 : undefined },
    cacheKey: `saved-tab:${leafId}`,
    waitTeardowns: new Array<() => void>(),
    deps: {
      tabId: 'saved-tab',
      worktreeId: 'repo::/bare',
      restoredPtyIdByLeafId: { [leafId]: 'saved-shell' },
      paneTransportsRef: { current: new Map([[1, transport]]) }
    },
    writeReplayData: (data: string) => terminal.write(data)
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The fixture supplies the addressed history/hold owner's entire session input.
  const session = fields as unknown as ConnectPanePtySession
  return { session, terminal, parsed: () => new Promise<void>((done) => terminal.write('', done)) }
}
function text(terminal: Terminal): string {
  const buffer = terminal.buffer.active
  return Array.from(
    { length: buffer.length },
    (_, row) => buffer.getLine(row)?.translateToString(true) ?? ''
  ).join('\n')
}

describe('saved terminal output is independent of replacement admission', () => {
  it('keeps the WSL held output and disabled input when Start is refused, then replaces only on acceptance', async () => {
    vi.stubGlobal('window', {
      api: {
        pty: {
          readNewerDaemonHeldScreen: async () => ({
            scrollback: 'ORIGINAL-HISTORY\r\n',
            cols: 80,
            rows: 8
          })
        }
      }
    })
    const { session, terminal, parsed } = fixture()
    let settle!: (value: null) => void
    const attempted = new Promise<null>((resolve) => {
      settle = resolve
    })
    holdForStoppedWslDistro(session, 'saved-shell', { distro: 'Ubuntu', state: 'stopped' }, () => {
      session.transportStreamGeneration += 1
      return attempted
    })
    await Promise.resolve()
    await Promise.resolve()
    await parsed()
    expect(text(terminal)).toContain('ORIGINAL-HISTORY')
    startHeldPanesForWslDistro('Ubuntu')
    await parsed()
    expect(text(terminal)).toContain('ORIGINAL-HISTORY')
    expect(terminal.options.disableStdin).toBe(true)
    settle(null)
    await attempted
    await parsed()
    expect(text(terminal)).toContain('ORIGINAL-HISTORY')
    expect(terminal.options.disableStdin).toBe(true)
    acceptRetainedTerminalHistory(session, true)
    session.writeReplayData('ACCEPTED-SUCCESSOR\r\n')
    await parsed()
    expect(text(terminal)).toContain('ACCEPTED-SUCCESSOR')
    expect(text(terminal)).not.toContain('ORIGINAL-HISTORY')
    expect(terminal.options.disableStdin).toBe(false)
  })

  it('reads the saved local association while leaving a nonrunning pane read-only', async () => {
    calls.rpc.mockResolvedValue({
      status: 'restored',
      scrollback: 'ENDED-LOCAL-HISTORY\r\n',
      cols: 80,
      rows: 8,
      partial: false
    })
    const { session, terminal, parsed } = fixture()
    await readSavedTerminalHistory(session)
    await parsed()
    expect(calls.rpc).toHaveBeenCalledWith(
      { kind: 'local' },
      'session.readTerminalHistory',
      {
        worktreeId: 'repo::/bare',
        tabId: 'saved-tab',
        leafId: '9300e770-619b-46a9-b648-f31d85641c19',
        executionHostId: 'local',
        expectedSessionId: 'saved-shell'
      },
      expect.any(Object)
    )
    expect(text(terminal)).toContain('ENDED-LOCAL-HISTORY')
    expect(terminal.options.disableStdin).toBe(true)
    acceptRetainedTerminalHistory(session, false)
    session.writeReplayData('SAME-OWNER-LIVE-OUTPUT')
    await parsed()
    expect(text(terminal)).toContain('ENDED-LOCAL-HISTORY')
    expect(text(terminal)).toContain('SAME-OWNER-LIVE-OUTPUT')
  })

  it('never falls back to local history for an old host or a re-paired owner', async () => {
    calls.proof.mockResolvedValue({
      supported: false,
      pairingRevision: 12,
      runtimeId: 'original-host'
    })
    const { session, terminal, parsed } = fixture('host')
    await readSavedTerminalHistory(session)
    expect(calls.rpc).not.toHaveBeenCalled()
    calls.proof.mockResolvedValue({
      supported: true,
      pairingRevision: 13,
      runtimeId: 'different-host'
    })
    replaceRuntimeEnvironmentRevisions([{ id: 'host', createdAt: 13 }], {
      retired: ['host'],
      sameHost: []
    })
    await readSavedTerminalHistory(session)
    expect(calls.rpc).not.toHaveBeenCalled()
    await parsed()
    expect(text(terminal)).not.toContain('ENDED-LOCAL-HISTORY')
  })

  it('reads through a proven rotation of the original host while retaining its request fence', async () => {
    const { session, terminal, parsed } = fixture('host')
    replaceRuntimeEnvironmentRevisions([{ id: 'host', createdAt: 13 }], {
      retired: [],
      sameHost: [{ id: 'host', fromRevision: 12, toRevision: 13 }]
    })
    calls.proof.mockResolvedValue({
      supported: true,
      pairingRevision: 13,
      runtimeId: 'original-host'
    })
    calls.rpc.mockResolvedValue({
      status: 'restored',
      scrollback: 'ORIGINAL-HOST-HISTORY',
      cols: 80,
      rows: 8,
      partial: false
    })
    await readSavedTerminalHistory(session)
    await parsed()
    expect(text(terminal)).toContain('ORIGINAL-HOST-HISTORY')
    expect(calls.rpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'host' },
      'session.readTerminalHistory',
      {
        worktreeId: 'repo::/bare',
        tabId: 'saved-tab',
        leafId: '9300e770-619b-46a9-b648-f31d85641c19'
      },
      expect.objectContaining({
        expectedEnvironmentPairingRevision: 13,
        expectedEnvironmentRuntimeId: 'original-host'
      })
    )
  })
  it('restores the captured grid before replaying cursor-positioned output and embedded links', async () => {
    calls.rpc.mockResolvedValue({
      status: 'restored',
      cols: 24,
      rows: 4,
      partial: false,
      scrollback: '\x1b[4;20HEDGE\x1b[1;1H\x1b]8;;https://example.com/saved\x07saved\x1b]8;;\x07'
    })
    const { session, terminal, parsed } = fixture()
    await readSavedTerminalHistory(session)
    await parsed()
    expect(terminal.buffer.active.getLine(3)?.translateToString(true)).toBe(
      '                   EDGE'
    )
    expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toBe('saved')
    expect(terminal.cols).toBe(24)
    expect(terminal.rows).toBe(4)
  })

  it('ignores a response after its captured runtime is paired to another owner', async () => {
    const { session, terminal, parsed } = fixture('host')
    calls.proof.mockResolvedValue({
      supported: true,
      pairingRevision: 12,
      runtimeId: 'original-host'
    })
    calls.rpc.mockImplementation(async () => {
      replaceRuntimeEnvironmentRevisions([{ id: 'host', createdAt: 13 }], {
        retired: ['host'],
        sameHost: []
      })
      return {
        status: 'restored',
        cols: 80,
        rows: 8,
        partial: false,
        scrollback: 'RETIRED-OWNER-OUTPUT'
      }
    })
    await readSavedTerminalHistory(session)
    await parsed()
    expect(text(terminal)).not.toContain('RETIRED-OWNER-OUTPUT')
  })
})
