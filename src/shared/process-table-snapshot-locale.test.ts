import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }))
vi.mock('node:child_process', () => ({ execFile: execFileMock }))

import { parseStrictProcessTableRows } from './process-table-snapshot'
import {
  getStrictProcessTableSnapshot,
  resetProcessTableSnapshotForTests
} from './process-table-snapshot-reader'

type Callback = (error: Error | null, result: { stdout: string; stderr: string }) => void

// What macOS `ps -axo pid=,ppid=,pgid=,tpgid=,stat=,tty=,lstart=,command=` prints for one pane
// agent under LANG=en_NZ.UTF-8, and under the pinned en_US.UTF-8.
const EN_NZ =
  '  300   101   300   300 S+   ttys003  Sat 10 Oct 00:04:51 2026     /opt/bin/claude --resume'
const EN_US =
  '  300   101   300   300 S+   ttys003  Sat Oct 10 00:04:51 2026     /opt/bin/claude --resume'

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
const lang = process.env.LANG

beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'darwin' })
  process.env.LANG = 'en_NZ.UTF-8'
  execFileMock.mockReset()
  resetProcessTableSnapshotForTests()
})
afterEach(() => {
  Object.defineProperty(process, 'platform', platform)
  process.env.LANG = lang
})

it('cannot read an en_NZ capture: the terminal and start time collapse into the command', () => {
  const [row] = parseStrictProcessTableRows(EN_NZ)
  expect(row.tty).toBeUndefined()
  expect(row.startTime).toBeUndefined()
  expect(row.command).toMatch(/^ttys003\s+Sat 10 Oct/)
})

it('captures under the pinned locale, so a user locale cannot hide the agent', async () => {
  execFileMock.mockImplementation(
    (_program, _args, options: { env: NodeJS.ProcessEnv }, callback: Callback) => {
      const pinned = options.env.LC_ALL === 'en_US.UTF-8' && options.env.LANG === undefined
      callback(null, { stdout: pinned ? EN_US : EN_NZ, stderr: '' })
    }
  )

  const [row] = await getStrictProcessTableSnapshot()

  expect(row).toEqual({
    pid: 300,
    ppid: 101,
    pgid: 300,
    tpgid: 300,
    stat: 'S+',
    tty: 'ttys003',
    startTime: 'Sat Oct 10 00:04:51 2026',
    command: '/opt/bin/claude --resume'
  })
})
