import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }))
vi.mock('node:child_process', () => ({ execFile: execFileMock }))

import {
  getFreshShellForegroundSnapshot,
  getProcessTableSnapshot,
  resetProcessTableSnapshotForTests
} from './process-table-snapshot-reader'
import { parseShellForegroundRows } from './process-table-snapshot'

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
    if (args[1]?.includes('tty=')) {
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
  finishFull(null, { stdout: shell, stderr: '' })
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
