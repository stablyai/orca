import { describe, expect, it, vi } from 'vitest'
import {
  readHookRootEvidence,
  type HookPaneProcessIo,
  type HookProcessVerdict,
  type TmuxPaneBridge
} from './hook-process-root-evidence'
import type { ProcessTableRow } from './process-table-snapshot'

// Shapes recorded on macOS: Orca's pane root is setuid login(1), the shell runs under it, and
// Claude's Bash tool runs each command in a new session with no terminal (`Ss`, `??`).
const LOGIN =
  '/usr/bin/login -flpq u /bin/bash --noprofile --norc -p -c export SHELL="$1"; shift; exec -l -- "$@" orca-tcc-login /bin/zsh /bin/zsh -l'
const TOOL_SHELL = (command: string) =>
  `/bin/zsh -c source '/Users/u/.claude/shell-snapshots/snapshot-zsh-1.sh' && eval '${command}' < /dev/null`

type Proc = [pid: number, ppid: number, pgid: number, command: string, stat: string, tty?: string]

function table(foreground: Record<string, number>, procs: Proc[]): ProcessTableRow[] {
  return procs.map(([pid, ppid, pgid, command, stat, tty = 'ttys004']) => ({
    pid,
    ppid,
    pgid,
    tpgid: foreground[tty] ?? 0,
    stat,
    tty,
    command
  }))
}

const ROOT: Proc = [100, 90, 100, LOGIN, 'Ss']
const SHELL: Proc = [101, 100, 101, '-zsh', 'S']
const CLAUDE: Proc = [4001, 101, 4001, 'claude', 'S+']

function io(
  rows: ProcessTableRow[],
  options: { root?: number; bridges?: (TmuxPaneBridge | null)[] } = {}
) {
  const bridges = options.bridges ?? []
  return {
    resolveRoot: vi.fn(async () => ({ pid: options.root ?? 100, incarnation: 'inc-1' })),
    probe: vi.fn(async () => 'live' as const),
    readProcesses: vi.fn(async (pids: readonly number[]) =>
      rows.filter((row) => pids.includes(row.pid))
    ),
    readTerminal: vi.fn(async (tty: string) => rows.filter((row) => row.tty === tty)),
    readTmux: vi.fn(async () => bridges.shift() ?? null)
  } satisfies HookPaneProcessIo
}

function read(deps: HookPaneProcessIo, pid: number, tmux?: { socket: string; pane: string }) {
  return readHookRootEvidence(
    {
      paneKey: 'pane',
      worktreeId: 'wt-1',
      agent: 'claude',
      process: { pid, platform: 'darwin', startTime: 'start' },
      ...(tmux ? { tmux } : {})
    },
    deps
  )
}

describe('a hook process read against its pane root', () => {
  it.each<[string, Record<string, number>, Proc[], number, HookProcessVerdict]>([
    ['the foreground agent', { ttys004: 4001 }, [ROOT, SHELL, CLAUDE], 4001, 'root'],
    [
      'an agent exec’d as the pane root',
      { ttys004: 100 },
      [[100, 90, 100, 'claude', 'Ss+']],
      100,
      'root'
    ],
    [
      'an agent under login(1) whose argv this user cannot read',
      { ttys004: 4001 },
      [[100, 90, 100, '(login)', 'Ss'], SHELL, CLAUDE],
      4001,
      'root'
    ],
    [
      'a shell script named after the agent that runs it',
      { ttys004: 4000 },
      [
        ROOT,
        SHELL,
        [4000, 101, 4000, 'bash /Users/u/bin/claude', 'S+'],
        [4001, 4000, 4000, 'node /opt/homebrew/bin/claude', 'S+']
      ],
      4001,
      'root'
    ],
    [
      'an npx launch',
      { ttys004: 4000 },
      [
        ROOT,
        SHELL,
        [
          4000,
          101,
          4000,
          'node /opt/homebrew/lib/node_modules/npm/bin/npm-cli.js exec claude',
          'S+'
        ],
        [4002, 4000, 4000, 'sh -c claude', 'S+'],
        [4001, 4002, 4000, 'node /Users/u/.npm/_npx/1/node_modules/.bin/claude', 'S+']
      ],
      4001,
      'root'
    ],
    [
      'a binary shim that spawns the agent in its own job',
      { ttys004: 4000 },
      [
        ROOT,
        SHELL,
        [4000, 101, 4000, 'claude', 'S+'],
        [4001, 4000, 4000, 'node /Users/u/.volta/tools/image/claude-code/cli.js', 'S+']
      ],
      4001,
      'unknown'
    ],
    [
      'a nested run from the agent’s detached Bash tool',
      { ttys004: 4001 },
      [
        ROOT,
        SHELL,
        CLAUDE,
        [4005, 4001, 4005, TOOL_SHELL('claude -p summarize'), 'Ss', '??'],
        [4006, 4005, 4005, 'claude -p summarize', 'S', '??']
      ],
      4006,
      'nested'
    ],
    [
      'a nested run under a versioned native agent',
      { ttys004: 4001 },
      [
        ROOT,
        SHELL,
        [4001, 101, 4001, '/Users/u/.local/share/claude/versions/2.1.0', 'S+'],
        [4005, 4001, 4005, TOOL_SHELL('bash /Users/u/bin/claude -p x'), 'Ss', '??'],
        [4006, 4005, 4005, 'bash /Users/u/bin/claude -p x', 'S', '??'],
        [4007, 4006, 4005, 'node /opt/homebrew/bin/claude -p x', 'S', '??']
      ],
      4007,
      'nested'
    ],
    [
      'a run under another agent',
      { ttys004: 4001 },
      [
        ROOT,
        SHELL,
        [4001, 101, 4001, 'codex', 'S+'],
        [4005, 4001, 4005, '/bin/bash -c claude -p x', 'Ss', '??'],
        [4006, 4005, 4005, 'claude -p x', 'S', '??']
      ],
      4006,
      'nested'
    ],
    [
      'a background agent while another holds the foreground',
      { ttys004: 4001 },
      [ROOT, SHELL, CLAUDE, [4010, 101, 4010, 'claude -p "nightly report"', 'S']],
      4010,
      'competing'
    ],
    [
      'a background agent beside the shell prompt',
      { ttys004: 101 },
      [ROOT, SHELL, [4010, 101, 4010, 'claude -p "nightly report"', 'S']],
      4010,
      'root'
    ],
    [
      'an agent in another app’s terminal that inherited the pane key',
      { ttys004: 4001, ttys009: 5001 },
      [
        ROOT,
        SHELL,
        [4001, 101, 4001, 'codex', 'S+'],
        [5000, 1, 5000, '/Applications/Code.app/Contents/MacOS/Code Helper', 'S', '??'],
        [5001, 5000, 5001, 'claude', 'S+', 'ttys009']
      ],
      5001,
      'competing'
    ],
    [
      'an agent in another terminal opened from the pane',
      { ttys004: 101, ttys009: 5001 },
      [
        ROOT,
        SHELL,
        [5000, 101, 5000, '/usr/local/bin/code-insiders --wait', 'S', '??'],
        [5001, 5000, 5001, 'claude', 'S+', 'ttys009']
      ],
      5001,
      'competing'
    ],
    [
      'an agent behind a bridge nobody can observe (screen)',
      { ttys004: 4020, ttys010: 4023 },
      [
        ROOT,
        SHELL,
        [4020, 101, 4020, 'screen -S work', 'S+'],
        [4021, 1, 4021, 'SCREEN -S work', 'Ss', '??'],
        [4022, 4021, 4022, '-zsh', 'Ss', 'ttys010'],
        [4023, 4022, 4023, 'claude', 'S+', 'ttys010']
      ],
      4023,
      'unknown'
    ],
    [
      'a detached agent with no terminal',
      { ttys004: 101 },
      [ROOT, SHELL, [4030, 101, 4030, 'claude', 'Ss', '??']],
      4030,
      'unknown'
    ],
    [
      'an agent under an ancestor whose argv is unreadable',
      { ttys004: 4000 },
      [ROOT, SHELL, [4000, 101, 4000, '(node)', 'S+'], [4001, 4000, 4000, 'claude', 'S+']],
      4001,
      'unknown'
    ]
  ])('%s', async (_name, foreground, procs, sender, verdict) => {
    const rows = table(foreground, procs)
    const deps = io(rows, { root: procs[0][0] })
    expect(await read(deps, sender)).toBe(verdict)
    // Targeted reads only: the root and the sender's own off-terminal ancestry, plus one terminal.
    expect(deps.readTerminal).toHaveBeenCalledTimes(1)
    expect(deps.readProcesses.mock.calls.every(([pids]) => pids.length === 1)).toBe(true)
  })

  it('reads a Linux nested run through its detached tool session', async () => {
    const rows = table({ 'pts/3': 4001 }, [
      [100, 90, 100, '/bin/bash --rcfile /orca/bash/rcfile', 'Ss', 'pts/3'],
      [
        4001,
        100,
        4001,
        'node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js',
        'Sl+',
        'pts/3'
      ],
      [4005, 4001, 4005, '/bin/bash -c claude -p x', 'Ss', '?'],
      [4006, 4005, 4005, 'claude -p x', 'Sl', '?']
    ])
    expect(await read(io(rows), 4006)).toBe('nested')
    expect(await read(io(rows), 4001)).toBe('root')
  })
})

describe('a hook process behind tmux in its pane', () => {
  const tmux = { socket: '/private/tmp/tmux-501/default', pane: '%1' }
  const rows = table({ ttys004: 4040, ttys011: 4043 }, [
    ROOT,
    SHELL,
    [4040, 101, 4040, 'tmux attach', 'S+'],
    // The server started elsewhere and outlives any one client.
    [4041, 1, 4041, 'tmux', 'Ss', '??'],
    [4042, 4041, 4042, '-zsh', 'Ss', 'ttys011'],
    [4043, 4042, 4043, 'claude', 'S+', 'ttys011']
  ])

  it.each<[string, (TmuxPaneBridge | null)[], HookProcessVerdict]>([
    [
      'acquires through the pane the outer client selects',
      [
        { selected: '%1', innerPid: 4042 },
        { selected: '%1', innerPid: 4042 }
      ],
      'root'
    ],
    ['refuses an inner pane the outer client does not show', [{ selected: '%2' }], 'competing'],
    [
      'proves nothing when the selection changes during the read',
      [{ selected: '%1', innerPid: 4042 }, { selected: '%2' }],
      'unknown'
    ],
    ['proves nothing when no single outer client is attached', [null], 'unknown']
  ])('%s', async (_name, bridges, verdict) => {
    expect(await read(io(rows, { bridges }), 4043, tmux)).toBe(verdict)
  })

  it('proves nothing without the hook’s tmux hint', async () => {
    expect(await read(io(rows), 4043)).toBe('unknown')
  })
})

describe('the pane root binding', () => {
  it('keeps the legacy path for a PTY whose owner names no root, and probes nothing', async () => {
    const deps = { ...io([]), resolveRoot: vi.fn(async () => 'legacy' as const) }
    expect(await read(deps, 4001)).toBeUndefined()
    expect(deps.probe).not.toHaveBeenCalled()
  })

  it('proves nothing for a missing binding or a sender that is not the hook’s process', async () => {
    expect(await read({ ...io([]), resolveRoot: vi.fn(async () => null) }, 4001)).toBe('unknown')
    const rows = table({ ttys004: 4001 }, [ROOT, SHELL, CLAUDE])
    expect(await read({ ...io(rows), probe: vi.fn(async () => 'exited' as const) }, 4001)).toBe(
      'unknown'
    )
  })
})
