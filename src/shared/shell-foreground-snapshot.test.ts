import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }))
vi.mock('node:child_process', () => ({ execFile: execFileMock }))

import {
  getFreshShellForegroundSnapshot,
  getFreshProcessTableSnapshot,
  getProcessTableSnapshot,
  getStrictProcessTableSnapshotWithAge,
  resetProcessTableSnapshotForTests
} from './process-table-snapshot-reader'
import { parseShellForegroundRows, PS_ARGS } from './process-table-snapshot'
import * as darwinTerminalNames from './darwin-terminal-names'

type Callback = (error: Error | null, result: { stdout: string; stderr: string }) => void
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
const shell = '100 99 100 100 Ss+ /bin/zsh -l'

beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'darwin' })
  execFileMock.mockReset()
  resetProcessTableSnapshotForTests()
})
afterEach(() => Object.defineProperty(process, 'platform', platform))

it('answers concurrent shell proofs without waiting for a pending full capture', async () => {
  let finishFull!: Callback
  execFileMock.mockImplementation((_program, args: string[], _options, callback: Callback) => {
    if (args[1]?.includes('tdev=')) {
      finishFull = callback
    } else {
      expect(args).toEqual(['-axo', 'pid=,ppid=,pgid=,tpgid=,stat=,command='])
      callback(null, { stdout: shell, stderr: '' })
    }
  })
  const full = getProcessTableSnapshot()
  const [first, second] = await Promise.all([
    getFreshShellForegroundSnapshot(),
    getFreshShellForegroundSnapshot()
  ])
  expect(first).toEqual([
    { pid: 100, ppid: 99, pgid: 100, tpgid: 100, stat: 'Ss+', command: '/bin/zsh -l' }
  ])
  expect(second).toBe(first)
  expect(execFileMock).toHaveBeenCalledTimes(2)
  finishFull(null, {
    stdout: '100 99 100 100 Ss+ ?? Fri Oct 9 12:34:56 2026 /bin/zsh -l',
    stderr: ''
  })
  await full
  await getFreshShellForegroundSnapshot()
  expect(execFileMock).toHaveBeenCalledTimes(3)
})

it('requires a new capture after an earlier shell proof has started', async () => {
  const callbacks: Callback[] = []
  execFileMock.mockImplementation((_program, _args, _options, callback: Callback) => {
    callbacks.push(callback)
  })
  const first = getFreshShellForegroundSnapshot()
  await vi.waitFor(() => expect(callbacks).toHaveLength(1))
  const second = getFreshShellForegroundSnapshot()
  callbacks[0]!(null, { stdout: shell, stderr: '' })
  await first
  await vi.waitFor(() => expect(callbacks).toHaveLength(2))
  callbacks[1]!(null, { stdout: shell.replace('Ss+', 'Ss'), stderr: '' })
  expect((await second)[0]?.stat).toBe('Ss')
})

// With no `tty=` column to absorb them, the shared parser read `python`/`3` as tty/start.
it('keeps an argv whose second token is numeric', () => {
  expect(parseShellForegroundRows('101 100 101 101 S+ /usr/bin/python 3 app.py')).toEqual([
    { pid: 101, ppid: 100, pgid: 101, tpgid: 101, stat: 'S+', command: '/usr/bin/python 3 app.py' }
  ])
})

it('rejects an unreadable shell capture', async () => {
  execFileMock.mockImplementation((_program, _args, _options, callback: Callback) => {
    callback(null, { stdout: '', stderr: '' })
  })
  await expect(getFreshShellForegroundSnapshot()).rejects.toThrow('empty_capture')
})

it('recaptures ordinary tty columns when the optimized full row has incomplete framing', async () => {
  execFileMock.mockImplementation((_program, args: string[], _options, callback: Callback) => {
    callback(null, {
      stdout: args[1]?.includes('tdev=')
        ? '100 99 100 100 Ss+ 16/9'
        : '100 99 100 100 Ss+ ttys009 Fri Oct 9 12:34:56 2026 /bin/zsh -l',
      stderr: ''
    })
  })

  expect((await getProcessTableSnapshot())[0]?.tty).toBe('ttys009')
  expect(execFileMock.mock.calls.map((call) => call[1][1])).toEqual([
    PS_ARGS[1].replace('tty=', 'tdev='),
    PS_ARGS[1]
  ])
})

it('shares one translated capture and includes naming time in its age and completion TTL', async () => {
  const raw = '100 99 100 100 Ss+ 16/9 Fri Oct 9 12:34:56 2026 /bin/zsh -l'
  const named = raw.replace('16/9', 'ttys009')
  let finishNaming: (stdout: string) => void = () => {
    throw new Error('naming did not start')
  }
  const naming = vi.spyOn(darwinTerminalNames, 'nameDarwinTerminals').mockImplementation(
    () =>
      new Promise((resolve) => {
        finishNaming = resolve
      })
  )
  const now = vi.spyOn(Date, 'now').mockReturnValue(1_000)
  try {
    execFileMock.mockImplementation((_program, _args, _options, callback: Callback) => {
      callback(null, { stdout: raw, stderr: '' })
    })
    const lenient = getProcessTableSnapshot()
    const strict = getStrictProcessTableSnapshotWithAge()
    await vi.waitFor(() => expect(naming).toHaveBeenCalledTimes(1))
    now.mockReturnValue(2_000)
    finishNaming(named)

    expect((await lenient)[0]?.tty).toBe('ttys009')
    expect(await strict).toMatchObject({ capturedAgeMs: 1_000, rows: [{ tty: 'ttys009' }] })
    now.mockReturnValue(2_300)
    expect((await getProcessTableSnapshot())[0]?.tty).toBe('ttys009')
    expect(execFileMock).toHaveBeenCalledTimes(1)
    expect(naming).toHaveBeenCalledTimes(1)
  } finally {
    naming.mockRestore()
    now.mockRestore()
  }
})

it.each([
  { message: 'ps: tdev: keyword not found', code: 1 },
  { message: 'error: unknown user-defined format specifier "tdev"', code: 2 }
])(
  'remembers an unsupported device column without caching terminal names ($message)',
  async ({ message, code }) => {
    execFileMock.mockImplementation((_program, args: string[], _options, callback: Callback) => {
      if (args[1]?.includes('tdev=')) {
        callback(Object.assign(new Error(message), { code }), { stdout: '', stderr: message })
      } else {
        callback(null, {
          stdout: '100 99 100 100 Ss+ ttys009 Fri Oct 9 12:34:56 2026 /bin/zsh -l',
          stderr: ''
        })
      }
    })

    expect((await getProcessTableSnapshot())[0]?.tty).toBe('ttys009')
    expect((await getFreshProcessTableSnapshot())[0]?.tty).toBe('ttys009')
    expect(execFileMock.mock.calls.map((call) => call[1][1])).toEqual([
      PS_ARGS[1].replace('tty=', 'tdev='),
      PS_ARGS[1],
      PS_ARGS[1]
    ])
    resetProcessTableSnapshotForTests()
    await getProcessTableSnapshot()
    expect(execFileMock).toHaveBeenCalledTimes(5)
  }
)

it.each([
  Object.assign(new Error('ps: another: keyword not found'), { code: 1 }),
  Object.assign(new Error('ps: Operation not permitted'), { code: 1 }),
  Object.assign(new Error('ps: tdev: keyword not found'), { code: 'EACCES' }),
  Object.assign(new Error('ps: tdev: keyword not found'), { code: 1, killed: true }),
  Object.assign(new Error('stdout maxBuffer length exceeded'), {
    code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
  })
])('does not retry or remember an unrelated failed capture (%s)', async (error) => {
  execFileMock.mockImplementation((_program, _args, _options, callback: Callback) => {
    callback(error, { stdout: '', stderr: '' })
  })

  await expect(getProcessTableSnapshot()).rejects.toThrow()
  await expect(getProcessTableSnapshot()).rejects.toThrow()
  expect(execFileMock.mock.calls.map((call) => call[1][1])).toEqual([
    PS_ARGS[1].replace('tty=', 'tdev='),
    PS_ARGS[1].replace('tty=', 'tdev=')
  ])
})
