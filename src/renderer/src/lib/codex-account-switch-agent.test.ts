import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type * as localPreflightContext from '@/lib/local-preflight-context'
import type * as paneSelectionLane from './pane-account-selection-lane'
import {
  confirmRuntimeTerminalForegroundProcess,
  inspectRuntimeTerminalProcess
} from '@/runtime/runtime-terminal-inspection'
import {
  CODEX_ACCOUNT_SWITCH_AGENT,
  resolveCodexSessionAccountId
} from './codex-account-switch-agent'
import {
  findMovableAgentSessions,
  findQueuedAccountRestartsOnAccount
} from './agent-account-switch-discovery'
import {
  ptyId,
  seedAgentPanes,
  type SeededAgentPane
} from './agent-account-switch-panes.test-fixture'

const laneByPtyId = vi.hoisted((): Record<string, string> => ({}))

vi.mock('@/runtime/runtime-terminal-inspection', () => ({
  inspectRuntimeTerminalProcess: vi.fn(),
  confirmRuntimeTerminalForegroundProcess: vi.fn()
}))
vi.mock('@/lib/local-preflight-context', async (importOriginal) => ({
  ...(await importOriginal<typeof localPreflightContext>()),
  getLocalProjectExecutionRuntimeContext: () => undefined
}))
vi.mock('./pane-account-selection-lane', async (importOriginal) => {
  const actual = await importOriginal<typeof paneSelectionLane>()
  return {
    ...actual,
    resolvePaneAccountSelectionLaneKey: (
      args: Parameters<typeof actual.resolvePaneAccountSelectionLaneKey>[0]
    ) => laneByPtyId[args.ptyId] ?? actual.resolvePaneAccountSelectionLaneKey(args)
  }
})

const LOCAL = { kind: 'local' } as const
const HOST = { runtime: 'host' } as const
const USER_DATA = '/Users/dev/Library/Application Support/orca'
const HOME_A = `${USER_DATA}/codex-accounts/acct-a/home`
const HOME_B = `${USER_DATA}/codex-accounts/acct-b/home`
const SYSTEM_HOME = '/Users/dev/.codex'
// Why it is System default: a host launch runs there when the user sets their own CODEX_HOME.
const MIRROR_HOME = `${USER_DATA}/codex-runtime-home/home`
const WSL_LINUX_HOME = '/home/dev/.local/share/orca/codex-accounts/acct-w/home'
const SERVER_HOME = '/srv/orca-data/codex-accounts/acct-s/home'
const rollout = (home: string): string => `${home}/sessions/2026/10/17/rollout-s.jsonl`

function seedCodexPanes(
  panes: (Omit<SeededAgentPane, 'transcriptPath'> & { home: string | null })[]
) {
  seedAgentPanes(
    panes.map(({ home, ...pane }) => ({
      agentType: 'codex',
      launchAgent: 'codex',
      ...pane,
      transcriptPath: home === null ? null : rollout(home)
    })),
    {}
  )
}

const movable = async (
  fromAccountId: string | null,
  target: { runtime: 'host' | 'wsl'; wslDistro?: string } = HOST
) =>
  (
    await findMovableAgentSessions(CODEX_ACCOUNT_SWITCH_AGENT, {
      owner: LOCAL,
      target,
      fromAccountId
    })
  ).map((pane) => pane.ptyId)

beforeEach(() => {
  for (const key of Object.keys(laneByPtyId)) {
    delete laneByPtyId[key]
  }
  vi.mocked(inspectRuntimeTerminalProcess).mockResolvedValue({
    foregroundProcess: 'codex',
    hasChildProcesses: true
  })
  vi.mocked(confirmRuntimeTerminalForegroundProcess).mockResolvedValue('codex')
})

describe('resolveCodexSessionAccountId', () => {
  it("reads a saved account from its home's place in Orca's account storage", () => {
    expect(resolveCodexSessionAccountId(rollout(HOME_A))).toBe('acct-a')
    expect(resolveCodexSessionAccountId(rollout(WSL_LINUX_HOME))).toBe('acct-w')
    expect(resolveCodexSessionAccountId(rollout(SERVER_HOME))).toBe('acct-s')
  })

  it("reads ~/.codex and Orca's mirror for a custom CODEX_HOME as System default", () => {
    expect(resolveCodexSessionAccountId(rollout(SYSTEM_HOME))).toBeNull()
    expect(resolveCodexSessionAccountId(rollout('/home/dev/.codex'))).toBeNull()
    expect(resolveCodexSessionAccountId(rollout(MIRROR_HOME))).toBeNull()
  })

  it('cannot tell the account of any other home or of a missing transcript', () => {
    expect(resolveCodexSessionAccountId(rollout('/work/codex-home'))).toBeUndefined()
    expect(resolveCodexSessionAccountId(undefined)).toBeUndefined()
  })

  it('reads Windows paths whatever their separators, keeping the id as written', () => {
    expect(
      resolveCodexSessionAccountId(
        'C:\\Users\\Dev\\AppData\\Roaming\\orca\\codex-accounts\\Acct-X\\home\\sessions\\2026\\rollout-s.jsonl'
      )
    ).toBe('Acct-X')
  })
})

describe('finding Codex sessions to move', () => {
  it('offers only the sessions on the account the switch left', async () => {
    seedCodexPanes([
      { n: 1, home: HOME_A },
      { n: 2, home: HOME_B },
      { n: 3, home: SYSTEM_HOME },
      { n: 4, home: MIRROR_HOME },
      { n: 5, home: '/work/codex-home' },
      { n: 6, agentType: 'claude', home: HOME_A }
    ])

    expect(await movable('acct-a')).toEqual([ptyId(1)])
    expect(await movable(null)).toEqual([ptyId(3), ptyId(4)])
  })

  it('offers nothing when switching back to the account the sessions still run on', async () => {
    seedCodexPanes([{ n: 1, home: HOME_A }])

    // A→B left the session on A; B→A finds nothing on B to move.
    expect(await movable('acct-b')).toEqual([])
  })

  it('finds a WSL session from its Linux home, only on its own distro', async () => {
    seedCodexPanes([
      { n: 1, home: WSL_LINUX_HOME },
      { n: 2, home: HOME_A }
    ])
    laneByPtyId[ptyId(1)] = 'wsl:Ubuntu'

    expect(await movable('acct-w', { runtime: 'wsl', wslDistro: 'Ubuntu' })).toEqual([ptyId(1)])
    expect(await movable('acct-w', { runtime: 'wsl', wslDistro: 'Debian' })).toEqual([])
    expect(await movable('acct-w')).toEqual([])
  })

  it("offers a WSL host's terminals on a switch of this desktop's selection for its distro", async () => {
    const wslHostPty = 'remote:wsl-ubuntu@@term-1'
    seedCodexPanes([{ n: 1, ptyId: wslHostPty, home: WSL_LINUX_HOME }])
    laneByPtyId[wslHostPty] = 'wsl:Ubuntu'

    expect(await movable('acct-w', { runtime: 'wsl', wslDistro: 'Ubuntu' })).toEqual([wslHostPty])
  })

  it("offers a paired server's sessions only on that server's switch", async () => {
    const serverPty = 'remote:env-1@@term-1'
    seedCodexPanes([
      { n: 1, ptyId: serverPty, home: SERVER_HOME },
      { n: 2, home: SERVER_HOME.replace('acct-s', 'acct-a') }
    ])
    laneByPtyId[serverPty] = 'env:env-1'
    const serverSwitch = (environmentId: string) =>
      findMovableAgentSessions(CODEX_ACCOUNT_SWITCH_AGENT, {
        owner: { kind: 'environment', environmentId },
        target: HOST,
        fromAccountId: 'acct-s'
      })

    expect((await serverSwitch('env-1')).map((pane) => pane.ptyId)).toEqual([serverPty])
    expect(await serverSwitch('env-2')).toEqual([])
    expect(await movable('acct-s')).toEqual([])
  })

  it('never offers an SSH pane, which keeps its own login', async () => {
    const sshPty = 'ssh:box@@pty-1'
    seedCodexPanes([{ n: 1, ptyId: sshPty, home: HOME_A }])

    expect(await movable('acct-a')).toEqual([])
  })

  it('offers nothing with hooks off, since no transcript names the account', async () => {
    seedCodexPanes([
      { n: 1, home: null },
      { n: 2, sessionId: null, home: null }
    ])

    expect(await movable('acct-a')).toEqual([])
    expect(await movable(null)).toEqual([])
  })

  it('recognizes codex.exe and re-checks a shell reading before skipping a pane', async () => {
    seedCodexPanes([
      { n: 1, home: HOME_A },
      { n: 2, home: HOME_A },
      { n: 3, home: HOME_A }
    ])
    vi.mocked(inspectRuntimeTerminalProcess).mockImplementation(async (id) =>
      id === ptyId(1)
        ? { foregroundProcess: 'codex.exe', hasChildProcesses: true }
        : { foregroundProcess: 'zsh', hasChildProcesses: false }
    )
    // The cached read flaps to the shell for pane 2; pane 3 really exited Codex.
    vi.mocked(confirmRuntimeTerminalForegroundProcess).mockImplementation(async (id) =>
      id === ptyId(2) ? 'codex' : 'zsh'
    )

    expect(await movable('acct-a')).toEqual([ptyId(1), ptyId(2)])
  })
})

describe('queued Codex restarts already on the account', () => {
  it('lists queued restarts whose session runs on the newly selected account', () => {
    seedCodexPanes([
      { n: 1, home: HOME_B },
      { n: 2, home: HOME_A },
      { n: 3, home: '/work/codex-home' }
    ])
    useAppStore.setState({
      pendingPaneAccountRestarts: { [ptyId(1)]: 'codex', [ptyId(2)]: 'codex', [ptyId(3)]: 'codex' }
    })

    expect(
      findQueuedAccountRestartsOnAccount(CODEX_ACCOUNT_SWITCH_AGENT, {
        owner: LOCAL,
        target: HOST,
        accountId: 'acct-b'
      })
    ).toEqual([ptyId(1)])
  })
})
