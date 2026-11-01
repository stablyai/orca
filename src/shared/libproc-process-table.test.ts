import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
import { resetPsFallbackForTests } from './libproc-ps-fallback'
import { createProcessTableSnapshotReader } from './process-table-snapshot-reader'
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
    readProcessCwd: vi.fn(async () => null),
    readProcessPath: vi.fn(async () => null),
    ...overrides
  }
  setLibprocAddonForTests(addon)
  return addon
}

// Orca's euid is pinned, so neither a root runner nor Windows (no geteuid) changes whose argv is "own".
const OWN_UID = 501
const OTHER_UID = 502
const realGeteuid = process.geteuid

beforeEach(() => {
  process.geteuid = () => OWN_UID
})

const PS_RESULT = {
  code: 0,
  signal: null,
  stdout: ' 1\n',
  stderr: '',
  timedOut: false,
  outputTruncated: false
}

afterEach(() => {
  process.geteuid = realGeteuid
  setLibprocAddonForTests(undefined)
  resetNativeReadsForTests()
  resetPsFallbackForTests()
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

  it('keeps the real ps for invocations it cannot reproduce, and answers a failing addon with /bin/ps', async () => {
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
    runProcess.mockResolvedValue(PS_RESULT)
    expect(await runPsInProcess(['-axo', 'pid='], BUDGET)).toEqual(PS_RESULT)
    expect(runProcess).toHaveBeenCalledWith(
      expect.objectContaining({ program: '/bin/ps', args: ['-axo', 'pid='] })
    )

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

  it('queues past the read cap without retaining timed-out waiters, then hands a stalled pool to budgeted ps', async () => {
    vi.useFakeTimers()
    const addon = installAddon({ readProcessTable: vi.fn(() => new Promise<never>(() => {})) })
    runProcess.mockResolvedValue(PS_RESULT)
    const read = (pid: number, timeoutMs = 50) =>
      runPsInProcess(['-p', String(pid), '-o', 'pid='], { timeoutMs })

    // Eight distinct reads fill the cap and stall; overflow callers wait on one slot notifier.
    const capped = Array.from({ length: 8 }, (_, index) => read(5000 + index, 10_000))
    const overflow = Array.from({ length: 300 }, (_, index) => read(6000 + index))
    expect(nativeReadWaitersForTests()).toBe(300)
    await vi.advanceTimersByTimeAsync(50)
    expect(nativeReadWaitersForTests()).toBe(0)
    // The stalled burst costs the fork budget, not one ps per caller; the rest time out like a killed ps.
    await vi.advanceTimersByTimeAsync(50)
    const results = await Promise.all(overflow)
    expect(results.filter((result) => result?.timedOut === false)).toHaveLength(4)
    expect(results.filter((result) => result?.timedOut === true)).toHaveLength(296)
    expect(runProcess).toHaveBeenCalledTimes(4)

    // The breaker stays open for its cool-down: callers go to ps without queueing on the pool.
    await vi.advanceTimersByTimeAsync(1_000)
    expect(await read(7000)).toEqual(PS_RESULT)
    expect(nativeReadWaitersForTests()).toBe(0)
    expect(addon.readProcessTable).toHaveBeenCalledTimes(8)
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
    expect(settled).toEqual(PS_RESULT)
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

  it('leaves argv of the user’s own mid-exec processes and of exiting ones to (comm), asking ps only for other users', async () => {
    const foreign = { ppid: 4242, tdev: TTYS004, uid: OTHER_UID, flags: 0x2 }
    const table = [
      ...TABLE,
      // A pane looping short commands: our own child between fork and exec reads like another user's.
      row({ pid: 4800, ppid: 4242, tdev: TTYS004, uid: OWN_UID, comm: 'git', command: '(git)' }),
      row({ ...foreign, pid: 4801, flags: 0x2 | 0x2000, comm: 'sudo', command: '(sudo)' }),
      row({ ...foreign, pid: 4802, status: 1, comm: 'sudo', command: '(sudo)' }),
      row({ ...foreign, pid: 4803, comm: 'node', command: '(node)' })
    ]
    installAddon({ readProcessTable: vi.fn(async (query: LibprocQuery) => tableFor(query, table)) })
    runProcess.mockResolvedValue({
      code: 0,
      signal: null,
      stdout: ' 4803 node /opt/claude/cli.js\n',
      stderr: '',
      timedOut: false
    })

    const result = await runPsInProcess(['-axo', 'pid=,command='], BUDGET)
    expect(result?.stdout).toContain('4800 (git)\n')
    expect(result?.stdout).toContain('4803 node /opt/claude/cli.js\n')
    expect(runProcess).toHaveBeenCalledTimes(1)
    expect(runProcess.mock.calls[0]?.[0].args.at(-1)).toBe('4803')
  })

  it('shares one argv ps among concurrent readers and waits out a failed recovery before asking again', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    const sudo = row({
      pid: 4900,
      ppid: 4242,
      tdev: TTYS004,
      uid: OTHER_UID,
      comm: 'node',
      command: '(node)'
    })
    installAddon({
      readProcessTable: vi.fn(async (query: LibprocQuery) => tableFor(query, [...TABLE, sudo]))
    })
    // ps omits a process that exited, or one it cannot read either.
    runProcess.mockResolvedValue({ code: 1, signal: null, stdout: '', stderr: '', timedOut: false })
    const read = (): Promise<unknown> =>
      runPsInProcess(['-o', 'pid=,command=', '-t', 'ttys004'], BUDGET)

    const concurrent = await Promise.all(Array.from({ length: 24 }, read))
    expect(concurrent).toEqual(Array(24).fill(expect.objectContaining({ timedOut: false })))
    expect(runProcess).toHaveBeenCalledTimes(1)

    await read()
    expect(runProcess).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(5_000)
    await read()
    expect(runProcess).toHaveBeenCalledTimes(2)
  })

  it('reuses recovered argv for at most 1.5s, so a same-comm re-exec is seen', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    const sudo = row({
      pid: 5100,
      ppid: 4242,
      tdev: TTYS004,
      uid: OTHER_UID,
      comm: 'node',
      command: '(node)'
    })
    installAddon({
      readProcessTable: vi.fn(async (query: LibprocQuery) => tableFor(query, [...TABLE, sudo]))
    })
    // Same pid, start time and comm: node re-exec'd from Claude into an unrelated server.
    let argv = 'node /opt/claude/cli.js'
    runProcess.mockImplementation(async () => ({
      code: 0,
      signal: null,
      stdout: ` 5100 ${argv}\n`,
      stderr: '',
      timedOut: false
    }))
    const args = ['-p', '5100', '-o', 'command=']

    expect((await runPsInProcess(args, BUDGET))?.stdout).toBe(`node /opt/claude/cli.js\n`)
    argv = 'node /srv/server.js'
    expect((await runPsInProcess(args, BUDGET))?.stdout).toBe(`node /opt/claude/cli.js\n`)
    await vi.advanceTimersByTimeAsync(1_500)
    expect((await runPsInProcess(args, BUDGET))?.stdout).toBe('node /srv/server.js\n')
    expect(runProcess).toHaveBeenCalledTimes(2)
  })

  it('waits out a failed recovery from when ps gave up, however long it ran', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    const sudo = row({
      pid: 5200,
      ppid: 4242,
      tdev: TTYS004,
      uid: OTHER_UID,
      comm: 'su',
      command: '(su)'
    })
    installAddon({
      readProcessTable: vi.fn(async (query: LibprocQuery) => tableFor(query, [...TABLE, sudo]))
    })
    // A loaded host: ps takes 6s, then omits the process.
    let finish: () => void = () => {}
    runProcess.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ code: 1, signal: null, stdout: '', stderr: '', timedOut: false })
        })
    )
    const read = () => runPsInProcess(['-p', '5200', '-o', 'command='], { timeoutMs: 10_000 })

    const slow = read()
    await vi.advanceTimersByTimeAsync(6_000)
    finish()
    await slow
    await read()
    expect(runProcess).toHaveBeenCalledTimes(1)
  })

  it('recovers a su pane’s argv within the recovery budget however often it is read', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    const su = row({
      pid: 5300,
      ppid: 4242,
      tdev: TTYS004,
      uid: OTHER_UID,
      comm: 'su',
      command: '(su)'
    })
    installAddon({
      readProcessTable: vi.fn(async (query: LibprocQuery) => tableFor(query, [...TABLE, su]))
    })
    runProcess.mockResolvedValue({
      code: 0,
      signal: null,
      stdout: ' 5300 su -l\n',
      stderr: '',
      timedOut: false
    })
    const args = ['-o', 'pid=,command=', '-t', 'ttys004']

    const reads: ReturnType<typeof runPsInProcess>[] = []
    for (let poll = 0; poll < 20; poll += 1) {
      // readTerminalProcessRows' budget: a read may wait for the next recovery token.
      reads.push(runPsInProcess(args, { ...BUDGET, timeoutMs: 3_000 }))
      await vi.advanceTimersByTimeAsync(750)
    }
    for (const read of await Promise.all(reads)) {
      expect(read?.stdout).toContain('5300 su -l\n')
    }
    // The recovery budget: a burst of 2, then one per 2s over the ~16s the reads span.
    expect(runProcess.mock.calls.length).toBeLessThanOrEqual(10)
  })

  it('asks again at once after a recovery ps that timed out, which proved nothing', async () => {
    const su = row({
      pid: 5350,
      ppid: 4242,
      tdev: TTYS004,
      uid: OTHER_UID,
      comm: 'su',
      command: '(su)'
    })
    installAddon({
      readProcessTable: vi.fn(async (query: LibprocQuery) => tableFor(query, [...TABLE, su]))
    })
    runProcess
      .mockResolvedValueOnce({
        code: null,
        signal: 'SIGTERM',
        stdout: '',
        stderr: '',
        timedOut: true
      })
      .mockResolvedValue({
        code: 0,
        signal: null,
        stdout: ' 5350 su -l\n',
        stderr: '',
        timedOut: false
      })
    const read = () => runPsInProcess(['-p', '5350', '-o', 'command='], BUDGET)

    expect((await read())?.stdout).toBe('(su)\n')
    expect((await read())?.stdout).toBe('su -l\n')
  })

  it('recovers the foreground of a terminal where no process of ours is left (exec su)', async () => {
    const root = { tdev: TTYS004, uid: OTHER_UID, flags: 0x2, tpgid: 5400 }
    const table = [
      row({ ...root, pid: 4200, ppid: 1, pgid: 4200, comm: 'login', command: '(login)' }),
      row({ ...root, pid: 5400, ppid: 4200, pgid: 5400, comm: 'sh', command: '(sh)' })
    ]
    installAddon({ readProcessTable: vi.fn(async (query: LibprocQuery) => tableFor(query, table)) })
    runProcess.mockResolvedValue({
      code: 0,
      signal: null,
      stdout: ' 5400 -sh\n',
      stderr: '',
      timedOut: false
    })

    const result = await runPsInProcess(['-o', 'pid=,command=', '-t', 'ttys004'], BUDGET)
    expect(result?.stdout).toContain('5400 -sh\n')
    // The pane's root login is not in the foreground group, so it never costs a ps.
    expect(runProcess.mock.calls.map(([spec]) => spec.args.at(-1))).toEqual(['5400'])
  })

  describe('recovered argv age in strict evidence', () => {
    // Each case its own pid: the argv cache is process-wide.
    let pid = 5500
    const agent = () =>
      row({
        pid,
        ppid: 4242,
        tdev: TTYS004,
        uid: OTHER_UID,
        comm: 'node',
        command: '(node)'
      })
    const args = ['-o', 'pid=,command=', '-t', 'ttys004']
    // The production reader, stamping on the same monotonic clock the fake timers drive.
    const strictReader = () =>
      createProcessTableSnapshotReader({
        runPs: (_fresh, inputAt) =>
          runPsInProcess(args, { ...BUDGET, timeoutMs: 10_000, onArgvReadAt: inputAt }).then(
            (result) => result?.stdout
          ),
        now: () => performance.now(),
        ttlMs: 0
      })
    const psAnswers = (argv: () => string) =>
      runProcess.mockImplementation(async () => ({
        code: 0,
        signal: null,
        stdout: ` ${pid} ${argv()}\n`,
        stderr: '',
        timedOut: false
      }))

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
      installAddon({
        readProcessTable: vi.fn(async (query: LibprocQuery) => tableFor(query, [...TABLE, agent()]))
      })
    })

    it('ages a capture by the cached argv it reused, so a same-comm re-exec cannot read as fresh', async () => {
      let argv = 'node /opt/claude/cli.js'
      psAnswers(() => argv)
      const reader = strictReader()
      await reader.getSnapshotWithAge()
      // node re-execs into a server; same pid, start time and comm.
      argv = 'node /srv/server.js'
      await vi.advanceTimersByTimeAsync(1_400)

      const snapshot = await reader.getSnapshotWithAge()
      expect(snapshot.value).toContain('claude')
      expect(snapshot.capturedAgeMs).toBeGreaterThanOrEqual(1_400)
    })

    it('never answers a reader with a recovery begun more than 1.5s before it asked', async () => {
      pid = 5600
      let finishSlow: (stdout: string) => void = () => {}
      runProcess
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              finishSlow = (stdout) =>
                resolve({ code: 0, signal: null, stdout, stderr: '', timedOut: false })
            })
        )
        .mockResolvedValue({
          code: 0,
          signal: null,
          stdout: ' 5600 node /srv/server.js\n',
          stderr: '',
          timedOut: false
        })
      // Two captures (say the daemon's and main's), sharing one recovery that takes 6s.
      void strictReader().getSnapshotWithAge()
      await vi.advanceTimersByTimeAsync(5_900)

      const late = strictReader().getSnapshotWithAge()
      await vi.advanceTimersByTimeAsync(100)
      finishSlow(' 5600 node /opt/claude/cli.js\n')
      const snapshot = await late
      expect(snapshot.value).toContain('/srv/server.js')
      expect(runProcess).toHaveBeenCalledTimes(2)
    })
  })
})
