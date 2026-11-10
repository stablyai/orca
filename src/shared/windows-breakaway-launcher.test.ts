import { describe, expect, it } from 'vitest'

import {
  ORCAD_WINDOWS_BREAKAWAY_CONTRACT,
  parseWindowsBreakawayLaunchReport,
  WINDOWS_BREAKAWAY_EXIT_CODES as RELAY_WINDOWS_BREAKAWAY_EXIT_CODES,
  WINDOWS_BREAKAWAY_LAUNCH_FLAG as RELAY_WINDOWS_BREAKAWAY_LAUNCH_FLAG,
  type WindowsBreakawayLaunchContract
} from './windows-breakaway-launch'
import {
  launchOutsideJob,
  parseWindowsBreakawayLaunchRequest,
  type SpawnOutsideJob,
  type WindowsBreakawayLauncher
} from './windows-breakaway-launcher'

// The launcher is contract-agnostic; this stands in for the retired relay's contract.
const RELAY_WINDOWS_BREAKAWAY_CONTRACT: WindowsBreakawayLaunchContract = {
  argsFlag: '--relay-args',
  reportMarker: 'ORCA_RELAY_LAUNCH'
}

const parseRelayWindowsBreakawayLaunch = (args: readonly string[]) =>
  parseWindowsBreakawayLaunchRequest(RELAY_WINDOWS_BREAKAWAY_CONTRACT, args)

function launcherFor(
  spawn: SpawnOutsideJob,
  creationTimeMs: number | null = null
): WindowsBreakawayLauncher {
  return { spawnOutsideJob: spawn, readCreationTimeMs: () => creationTimeMs }
}

const argv = [
  'C:\\rt\\node.exe',
  'C:\\Users\\me user\\.orca-remote\\relay-1\\relay.js',
  RELAY_WINDOWS_BREAKAWAY_LAUNCH_FLAG,
  '--stdout-file',
  'C:/Users/me user/relay.log',
  '--stderr-file',
  'C:/Users/me user/relay.err.log',
  '--relay-args',
  '--detached',
  '--sock-path',
  '\\\\.\\pipe\\orca-relay-1',
  '--log-file',
  'C:/Users/me user/relay.log'
]

describe('relay Windows breakaway launcher', () => {
  it('takes its own flags before -- and hands the rest to the relay', () => {
    expect(parseRelayWindowsBreakawayLaunch(argv)).toEqual({
      stdoutPath: 'C:/Users/me user/relay.log',
      stderrPath: 'C:/Users/me user/relay.err.log',
      env: {},
      programArgs: argv.slice(8)
    })
  })
})

describe('orcad Windows breakaway launcher', () => {
  const orcadArgv = [
    'C:\\rt\\node.exe',
    'C:\\Users\\me\\.orca-remote\\orcad-1\\orcad.js',
    RELAY_WINDOWS_BREAKAWAY_LAUNCH_FLAG,
    '--stdout-file',
    'C:/slot/.orcad-readiness',
    '--stderr-file',
    'C:/slot/orcad.log',
    '--process-file',
    'C:/slot/.orcad-process.json',
    '--orcad-args',
    '--json',
    '--bind',
    '127.0.0.1'
  ]
  const orcadRuntime = { execPath: orcadArgv[0], script: orcadArgv[1], cwd: 'C:/slot' }

  it('splits on its own args flag, not the relay one', () => {
    expect(parseWindowsBreakawayLaunchRequest(ORCAD_WINDOWS_BREAKAWAY_CONTRACT, orcadArgv)).toEqual(
      {
        stdoutPath: 'C:/slot/.orcad-readiness',
        stderrPath: 'C:/slot/orcad.log',
        processFilePath: 'C:/slot/.orcad-process.json',
        env: {},
        programArgs: ['--json', '--bind', '127.0.0.1']
      }
    )
  })

  it('collects --env assignments for the launched process and refuses a malformed one', () => {
    const withEnv = [
      ...orcadArgv.slice(0, 3),
      '--env',
      'ORCA_VERSION=0.2.0+bb01',
      '--env',
      'ORCA_USER_DATA=C:/Users/Ann Lee/.orca',
      ...orcadArgv.slice(3)
    ]
    expect(
      parseWindowsBreakawayLaunchRequest(ORCAD_WINDOWS_BREAKAWAY_CONTRACT, withEnv)?.env
    ).toEqual({ ORCA_VERSION: '0.2.0+bb01', ORCA_USER_DATA: 'C:/Users/Ann Lee/.orca' })
    expect(() =>
      parseWindowsBreakawayLaunchRequest(ORCAD_WINDOWS_BREAKAWAY_CONTRACT, [
        ...orcadArgv.slice(0, 3),
        '--env',
        'lower=1',
        ...orcadArgv.slice(3)
      ])
    ).toThrow('NAME=VALUE')
  })

  it('fails the launch and stops the process when its record cannot be written', () => {
    const request = parseWindowsBreakawayLaunchRequest(ORCAD_WINDOWS_BREAKAWAY_CONTRACT, orcadArgv)
    if (!request) {
      throw new Error('expected a launch request')
    }
    const terminated: number[] = []
    const outcome = launchOutsideJob(
      request,
      launcherFor(() => ({ ok: true, pid: 4242, inJob: false })),
      orcadRuntime,
      () => {
        throw Object.assign(new Error('EACCES'), { errno: -4048 })
      },
      (pid) => terminated.push(pid)
    )
    expect(outcome).toEqual({
      report: { method: 'failed', reason: 'process-file', code: -4048 },
      exitCode: RELAY_WINDOWS_BREAKAWAY_EXIT_CODES.failed
    })
    expect(terminated).toEqual([4242])
  })

  it('reports under its own marker, which the relay parser does not read', () => {
    const line = 'ORCA_ORCAD_LAUNCH {"method":"breakaway","pid":9,"inJob":false}'
    expect(parseWindowsBreakawayLaunchReport(ORCAD_WINDOWS_BREAKAWAY_CONTRACT, line)).toEqual({
      method: 'breakaway',
      pid: 9,
      inJob: false
    })
    expect(parseWindowsBreakawayLaunchReport(RELAY_WINDOWS_BREAKAWAY_CONTRACT, line)).toBeNull()
  })
})
