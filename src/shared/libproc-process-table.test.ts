import { afterEach, describe, expect, it, vi } from 'vitest'

const { runProcess } = vi.hoisted(() => ({ runProcess: vi.fn() }))
vi.mock('@orca/process-host', () => ({ runProcess }))
vi.mock('./darwin-terminal-names', () => ({
  nameDarwinTerminalDevices: async (devices: ReadonlySet<string>) =>
    new Map([...devices].filter((device) => device === '16/4').map((device) => [device, 'ttys004']))
}))

import {
  setLibprocAddonForTests,
  type LibprocAddon,
  type LibprocProcessRow,
  type LibprocQuery
} from './libproc-addon'
import { nativeReadWaitersForTests, resetNativeReadsForTests } from './libproc-native-reads'
import { runPsInProcess } from './libproc-process-table'
import { parseCheapProcessTableRows, parseStrictProcessTableRows } from './process-table-snapshot'

const TTYS004 = (16 << 24) | 4
// 2026-09-03T16:02:01Z, a single-digit day so lstart pads it.
const START = Date.UTC(2026, 8, 3, 16, 2, 1) / 1000
// Pin the locale so lstart formatting doesn't depend on the runner's LANG.
const BUDGET = { timeoutMs: 1000, env: { LC_ALL: 'C' } }

function row(overrides: Partial<LibprocProcessRow>): LibprocProcessRow {
  return {
    pid: 1,
    ppid: 0,
    pgid: 1,
    tpgid: 0,
    tdev: -1,
    status: 2,
    flags: 0,
    sessionLeader: false,
    startSec: START,
    comm: 'launchd',
    command: '/sbin/launchd',
    commandIncomplete: true,
    ...overrides
  }
}

const TABLE = [
  row({
    pid: 4300,
    ppid: 4242,
    pgid: 4300,
    tpgid: 4300,
    tdev: TTYS004,
    flags: 0x2,
    comm: 'node',
    command: 'node /usr/local/bin/claude --resume',
    commandIncomplete: false
  }),
  row({
    pid: 4242,
    ppid: 4200,
    pgid: 4242,
    tpgid: 4300,
    tdev: TTYS004,
    flags: 0x2,
    sessionLeader: true,
    comm: 'zsh',
    command: '-zsh',
    commandIncomplete: false
  }),
  // A pane's root login is root-owned and sits under the terminal host.
  row({
    pid: 4200,
    ppid: 1,
    pgid: 4200,
    tdev: TTYS004,
    flags: 0x2,
    comm: 'login',
    command: '/usr/bin/login'
  }),
  row({
    pid: 4400,
    ppid: 4242,
    pgid: 4400,
    tpgid: 4300,
    status: 4,
    comm: 'vim',
    command: 'vim',
    commandIncomplete: false
  }),
  row({ pid: 4401, ppid: 4242, pgid: 4401, status: 5, comm: 'sh', command: '<defunct>' }),
  row({})
]

function tableFor(
  query: LibprocQuery,
  table: readonly LibprocProcessRow[] = TABLE
): LibprocProcessRow[] | null {
  if (query.tty !== undefined && !/^(?:\/dev\/)?ttys004$/.test(query.tty)) {
    return null
  }
  return table
    .filter((entry) => !query.pids || query.pids.includes(entry.pid))
    .filter((entry) => query.tty === undefined || entry.tdev === TTYS004)
    .map((entry) =>
      query.command ? entry : { ...entry, command: undefined, commandIncomplete: undefined }
    )
}

function installAddon(overrides: Partial<LibprocAddon> = {}): LibprocAddon {
  const addon: LibprocAddon = {
    readProcessTable: vi.fn(async (query: LibprocQuery) => tableFor(query)),
    processCwd: vi.fn(() => null),
    processPath: vi.fn(() => null),
    ...overrides
  }
  setLibprocAddonForTests(addon)
  return addon
}

afterEach(() => {
  setLibprocAddonForTests(undefined)
  resetNativeReadsForTests()
  runProcess.mockReset()
  vi.useRealTimers()
})

describe('runPsInProcess', () => {
  it('prints a whole-table capture the strict and cheap parsers read like ps output', async () => {
    installAddon()
    const utc = { env: { TZ: 'UTC0', LC_ALL: 'C' }, timeoutMs: 1000 }

    const full = await runPsInProcess(
      ['-axo', 'pid=,ppid=,pgid=,tpgid=,stat=,tty=,lstart=,command='],
      utc
    )
    expect(full?.code).toBe(0)
    // ps sorts by terminal, then pid.
    expect(parseStrictProcessTableRows(full!.stdout)).toEqual([
      expect.objectContaining({ pid: 1, tty: '??', command: '/sbin/launchd' }),
      expect.objectContaining({ pid: 4400, stat: 'T', tty: '??', command: 'vim' }),
      expect.objectContaining({ pid: 4401, stat: 'Z', command: '<defunct>' }),
      expect.objectContaining({ pid: 4200, stat: 'S', tty: 'ttys004', command: '/usr/bin/login' }),
      expect.objectContaining({ pid: 4242, stat: 'Ss', tty: 'ttys004', command: '-zsh' }),
      expect.objectContaining({
        pid: 4300,
        stat: 'S+',
        tty: 'ttys004',
        startTime: 'Thu Sep  3 16:02:01 2026',
        command: 'node /usr/local/bin/claude --resume'
      })
    ])
    // Neither the root daemon nor the pane's root login is a pane descendant worth a setuid ps.
    expect(runProcess).not.toHaveBeenCalled()

    const cheap = await runPsInProcess(['-axo', 'pid=,ppid=,pgid=,tpgid=,stat=,lstart='], utc)
    expect(parseCheapProcessTableRows(cheap!.stdout).at(-1)).toEqual({
      pid: 4300,
      ppid: 4242,
      pgid: 4300,
      tpgid: 4300,
      stat: 'S+',
      startTime: 'Thu Sep  3 16:02:01 2026'
    })
  })

  it('selects by pid or terminal and exits 1 like ps when nothing matches', async () => {
    const addon = installAddon()

    expect(await runPsInProcess(['-p', '4300,4300', '-o', 'pid=,tdev='], BUDGET)).toMatchObject({
      code: 0,
      stdout: '4300 16/4\n'
    })
    expect(addon.readProcessTable).toHaveBeenLastCalledWith({ command: false, pids: [4300] })
    expect(await runPsInProcess(['-p', '9999', '-o', 'stat=,lstart='], BUDGET)).toMatchObject({
      code: 1,
      stdout: ''
    })
    const tty = await runPsInProcess(['-o', 'pid=,stat=', '-t', '/dev/ttys004'], BUDGET)
    expect(tty?.stdout).toBe('4200 S\n4242 Ss\n4300 S+\n')
    expect(addon.readProcessTable).toHaveBeenLastCalledWith({ command: false, tty: '/dev/ttys004' })
    expect(await runPsInProcess(['-o', 'pid=', '-t', 'ttys999'], BUDGET)).toMatchObject({
      code: 1,
      timedOut: false
    })
  })

  it('keeps the real ps for invocations it cannot reproduce or a failing addon', async () => {
    installAddon()
    expect(await runPsInProcess(['-axo', 'pid=PROCESS_ID'], BUDGET)).toBeNull()
    expect(await runPsInProcess(['-axo', 'pid=,uid='], BUDGET)).toBeNull()
    expect(await runPsInProcess(['-e', '-o', 'pid='], BUDGET)).toBeNull()
    expect(await runPsInProcess(['-p', '1', '-t', 'ttys004', '-o', 'pid='], BUDGET)).toBeNull()
    expect(
      await runPsInProcess(['-axo', 'lstart='], { env: { TZ: 'America/New_York' }, timeoutMs: 1 })
    ).toBeNull()
    expect(
      await runPsInProcess(['-axo', 'lstart='], { env: { LC_ALL: 'de_DE.UTF-8' }, timeoutMs: 1 })
    ).toBeNull()

    installAddon({
      readProcessTable: async () => {
        throw new Error('sysctl failed')
      }
    })
    expect(await runPsInProcess(['-axo', 'pid='], BUDGET)).toBeNull()

    setLibprocAddonForTests(null)
    expect(await runPsInProcess(['-axo', 'pid='], BUDGET)).toBeNull()
  })

  it('times out each caller of a stalled shared read like a killed ps', async () => {
    vi.useFakeTimers()
    const addon = installAddon({ readProcessTable: vi.fn(() => new Promise<never>(() => {})) })

    const short = runPsInProcess(['-p', '4300', '-o', 'pid=,tpgid=,tty='], { timeoutMs: 125 })
    const long = runPsInProcess(['-p', '4300', '-o', 'pid=,tpgid=,tty='], { timeoutMs: 1000 })
    await vi.advanceTimersByTimeAsync(125)
    await expect(short).resolves.toMatchObject({ code: null, timedOut: true, stdout: '' })
    await vi.advanceTimersByTimeAsync(875)
    await expect(long).resolves.toMatchObject({ timedOut: true })
    expect(addon.readProcessTable).toHaveBeenCalledTimes(1)
  })

  it('asks ps once for argv only it can read, for another user’s process under a pane shell', async () => {
    const sudo = row({
      pid: 4500,
      ppid: 4242,
      pgid: 4500,
      tpgid: 4300,
      tdev: TTYS004,
      flags: 0x2,
      comm: 'node',
      command: '/usr/local/bin/node'
    })
    installAddon({
      readProcessTable: vi.fn(async (query: LibprocQuery) => tableFor(query, [...TABLE, sudo]))
    })
    runProcess.mockResolvedValue({
      code: 0,
      signal: null,
      stdout: ' 4500 node /usr/local/lib/claude-code/cli.js\n',
      stderr: '',
      timedOut: false
    })
    const args = ['-o', 'pid=,ppid=,pgid=,tpgid=,stat=,command=', '-t', 'ttys004']
    const options = { env: { LC_ALL: 'en_US.UTF-8' }, timeoutMs: 1000 }

    for (let poll = 0; poll < 2; poll += 1) {
      const result = await runPsInProcess(args, options)
      expect(result?.stdout).toContain(
        '4500 4242 4500 4300 S node /usr/local/lib/claude-code/cli.js'
      )
      expect(result?.stdout).toContain('4200 1 4200 0 S /usr/bin/login')
    }
    expect(runProcess).toHaveBeenCalledTimes(1)
    expect(runProcess).toHaveBeenCalledWith(
      expect.objectContaining({
        program: '/bin/ps',
        args: ['-ww', '-o', 'pid=,command=', '-p', '4500']
      })
    )
  })

  it('never joins a read submitted before the request, so stale rows never reach a caller', async () => {
    type Rows = LibprocProcessRow[] | null
    let finishStale: (rows: Rows) => void = () => {}
    const stale = new Promise<Rows>((resolve) => {
      finishStale = resolve
    })
    const readProcessTable = vi
      .fn<(query: LibprocQuery) => Promise<Rows>>()
      .mockReturnValueOnce(stale)
      .mockImplementation(async (query) => tableFor(query))
    installAddon({ readProcessTable })
    const args = ['-axo', 'pid=,ppid=']

    expect(await runPsInProcess(args, { timeoutMs: 10 })).toMatchObject({ timedOut: true })
    const fresh = runPsInProcess(args, BUDGET)
    finishStale([row({ pid: 9999, ppid: 4242 })])
    expect((await fresh)?.stdout).not.toContain('9999')
    expect(readProcessTable).toHaveBeenCalledTimes(2)
  })

  it('queues past the read cap without retaining timed-out waiters, then hands a stalled pool to ps', async () => {
    vi.useFakeTimers()
    installAddon({ readProcessTable: vi.fn(() => new Promise<never>(() => {})) })
    const read = (pid: number, timeoutMs = 50) =>
      runPsInProcess(['-p', String(pid), '-o', 'pid='], { timeoutMs })

    // Eight distinct reads fill the cap and stall; overflow callers wait on one slot notifier.
    const capped = Array.from({ length: 8 }, (_, index) => read(5000 + index, 10_000))
    const overflow = Array.from({ length: 300 }, (_, index) => read(6000 + index))
    expect(nativeReadWaitersForTests()).toBe(300)
    await vi.advanceTimersByTimeAsync(50)
    expect(nativeReadWaitersForTests()).toBe(0)
    expect(await Promise.all(overflow)).toEqual(Array(300).fill(null))

    // The breaker stays open for its cool-down: callers run ps without queueing.
    expect(await read(7000)).toBeNull()
    expect(nativeReadWaitersForTests()).toBe(0)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await Promise.all(capped)).toEqual(
      Array(8).fill(expect.objectContaining({ timedOut: true }))
    )

    // Past the cool-down with the cap still held, callers learn it at once instead of after their timeout.
    await vi.advanceTimersByTimeAsync(30_000)
    let settled: unknown = 'pending'
    void read(8000, 5_000).then((result) => {
      settled = result
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toBeNull()
  })

  it('recovers argv for a sudo use_pty tree on its own pty, but not for root daemons or GUI helpers', async () => {
    const TTYS005 = (16 << 24) | 5
    const root = { commandIncomplete: true, flags: 0x2 }
    const table = [
      ...TABLE,
      row({
        ...root,
        pid: 4600,
        ppid: 4242,
        tdev: TTYS004,
        comm: 'sudo',
        command: '/usr/bin/sudo'
      }),
      row({
        ...root,
        pid: 4601,
        ppid: 4600,
        tdev: TTYS005,
        comm: 'sudo',
        command: '/usr/bin/sudo'
      }),
      row({ ...root, pid: 4602, ppid: 4601, tdev: TTYS005, comm: 'zsh', command: '/bin/zsh' }),
      row({ ...root, pid: 4603, ppid: 4602, tdev: TTYS005, comm: 'node', command: '/opt/node' }),
      row({ pid: 300, ppid: 1, comm: 'syslogd', command: '/usr/sbin/syslogd' }),
      row({
        pid: 700,
        ppid: 1,
        comm: 'Orca',
        command: '/Applications/Orca',
        commandIncomplete: false
      }),
      row({ pid: 701, ppid: 700, comm: 'helper', command: '/usr/libexec/helper' })
    ]
    installAddon({ readProcessTable: vi.fn(async (query: LibprocQuery) => tableFor(query, table)) })
    runProcess.mockResolvedValue({ code: 0, signal: null, stdout: '', stderr: '', timedOut: false })

    await runPsInProcess(['-axo', 'pid=,command='], { env: { LC_ALL: 'C' }, timeoutMs: 1000 })
    const pids = runProcess.mock.calls[0]?.[0].args.at(-1).split(',').map(Number).sort()
    expect(pids).toEqual([4600, 4601, 4602, 4603])
  })

  it('asks ps again once exec changes the program behind a cached pid and start time', async () => {
    const shell = row({ pid: 4700, ppid: 4242, tdev: TTYS004, comm: 'zsh', command: '/bin/zsh' })
    let current = shell
    installAddon({
      readProcessTable: vi.fn(async (query: LibprocQuery) => tableFor(query, [...TABLE, current]))
    })
    runProcess.mockImplementation(async () => ({
      code: 0,
      signal: null,
      stdout: current === shell ? ' 4700 -zsh\n' : ' 4700 node /opt/claude/cli.js\n',
      stderr: '',
      timedOut: false
    }))
    const args = ['-p', '4700', '-o', 'command=']
    const options = { env: { LC_ALL: 'C' }, timeoutMs: 1000 }

    expect((await runPsInProcess(args, options))?.stdout).toBe('-zsh\n')
    expect((await runPsInProcess(args, options))?.stdout).toBe('-zsh\n')
    current = { ...shell, comm: 'node', command: '/opt/node' }
    expect((await runPsInProcess(args, options))?.stdout).toBe('node /opt/claude/cli.js\n')
    expect(runProcess).toHaveBeenCalledTimes(2)
  })

  it('lets concurrent tty= readers wait out one naming pass instead of running ps', async () => {
    installAddon()
    // 4300's read is still stalled from the timeout case above.
    const args = ['-o', 'pid=,tty=', '-p', '4242']
    const results = await Promise.all([1, 2, 3].map(() => runPsInProcess(args, BUDGET)))
    expect(results.map((result) => result?.stdout)).toEqual(Array(3).fill('4242 ttys004\n'))
    expect(runProcess).not.toHaveBeenCalled()
  })
})
