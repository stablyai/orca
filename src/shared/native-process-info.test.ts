import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as appEnvironment from './app-environment'
import {
  getNativeProcessInfo,
  loadNativeProcessInfoFrom,
  NATIVE_PROCESS_INFO_BUILD_PATH,
  NATIVE_PROCESS_INFO_RESOURCE_PATH,
  setNativeProcessInfoForTests,
  type NativeProcessInfo
} from './native-process-info'

describe.runIf(process.platform === 'darwin')('trusted native addon selection', () => {
  const resourcesDescriptor = Object.getOwnPropertyDescriptor(process, 'resourcesPath')
  const native: NativeProcessInfo = { readProcessForegroundGroup: () => null }
  let scratch = ''
  const hasEnvironment = () => vi.spyOn(appEnvironment, 'hasAppEnvironment')
  const loadAddon = () => vi.spyOn(process, 'dlopen')

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'orca-proc-info-selection-'))
    for (const relative of [NATIVE_PROCESS_INFO_BUILD_PATH, NATIVE_PROCESS_INFO_RESOURCE_PATH]) {
      mkdirSync(dirname(join(scratch, relative)), { recursive: true })
      writeFileSync(join(scratch, relative), 'fixture')
    }
    Object.defineProperty(process, 'resourcesPath', { configurable: true, value: scratch })
    vi.stubEnv('ORCA_DISABLE_NATIVE_PROCESS_INFO', '0')
    hasEnvironment().mockReturnValue(false)
    vi.spyOn(appEnvironment, 'getAppEnvironment').mockReturnValue({
      getAppPath: () => scratch,
      isPackaged: () => false,
      getPath: () => scratch,
      getVersion: () => 'fixture',
      getAppMetrics: () => [],
      onWillQuit: () => {},
      exit: () => {}
    })
    loadAddon().mockImplementation((module) => {
      Object.assign(module, { exports: native })
    })
    setNativeProcessInfoForTests(undefined)
  })

  afterEach(() => {
    setNativeProcessInfoForTests(undefined)
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    if (resourcesDescriptor) {
      Object.defineProperty(process, 'resourcesPath', resourcesDescriptor)
    } else {
      Reflect.deleteProperty(process, 'resourcesPath')
    }
    rmSync(scratch, { recursive: true, force: true })
  })

  it('loads packaged resources before app initialization and caches the result', () => {
    writeFileSync(join(scratch, 'app.asar'), '')
    expect(getNativeProcessInfo()).toBe(native)
    expect(getNativeProcessInfo()).toBe(native)
    const path = join(scratch, NATIVE_PROCESS_INFO_RESOURCE_PATH)
    expect(loadAddon()).toHaveBeenCalledExactlyOnceWith(expect.anything(), path)
  })

  it.each(['missing', 'incompatible'])('caches a definitive packaged %s result', (mode) => {
    writeFileSync(join(scratch, 'app.asar'), '')
    if (mode === 'missing') {
      rmSync(join(scratch, NATIVE_PROCESS_INFO_RESOURCE_PATH))
    } else {
      loadAddon().mockImplementationOnce(() => {
        throw new Error('incompatible architecture')
      })
    }
    expect(getNativeProcessInfo()).toBeNull()
    writeFileSync(join(scratch, NATIVE_PROCESS_INFO_RESOURCE_PATH), 'repaired fixture')
    expect(getNativeProcessInfo()).toBeNull()
    expect(loadAddon()).toHaveBeenCalledTimes(mode === 'missing' ? 0 : 1)
  })

  it('does not probe cwd and retries only after an explicit development environment appears', () => {
    vi.spyOn(process, 'cwd').mockReturnValue(scratch)
    expect(getNativeProcessInfo()).toBeNull()
    expect(loadAddon()).not.toHaveBeenCalled()
    hasEnvironment().mockReturnValue(true)
    expect(getNativeProcessInfo()).toBe(native)
    const path = join(scratch, NATIVE_PROCESS_INFO_BUILD_PATH)
    expect(loadAddon()).toHaveBeenCalledExactlyOnceWith(expect.anything(), path)
  })

  it('never probes the development path for a packaged environment without resources', () => {
    hasEnvironment().mockReturnValue(true)
    vi.spyOn(appEnvironment.getAppEnvironment(), 'isPackaged').mockReturnValue(true)
    expect(getNativeProcessInfo()).toBeNull()
    expect(loadAddon()).not.toHaveBeenCalled()
  })
})

describe('loadNativeProcessInfoFrom', () => {
  it('returns null for a missing or foreign module', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'orca-proc-info-foreign-'))
    try {
      writeFileSync(join(scratch, 'not-an-addon.node'), 'plain text')
      expect(loadNativeProcessInfoFrom(join(scratch, 'missing.node'))).toBeNull()
      expect(loadNativeProcessInfoFrom(join(scratch, 'not-an-addon.node'))).toBeNull()
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  })
})

describe.runIf(process.platform === 'darwin')('native PTY foreground group against ps', () => {
  let scratch = ''
  let addon: NativeProcessInfo
  let terminal: ChildProcess
  let sleeperPid = 0
  let tty = ''

  beforeAll(async () => {
    scratch = mkdtempSync(join(tmpdir(), 'orca-proc-info-'))
    const addonPath = join(scratch, 'orca-proc-info.node')
    execFileSync(
      process.execPath,
      ['config/scripts/build-proc-info-macos.mjs', '--single-arch', '--output', addonPath],
      { stdio: 'inherit' }
    )
    const loaded = loadNativeProcessInfoFrom(addonPath)
    if (!loaded) {
      throw new Error('native foreground addon did not load')
    }
    addon = loaded
    terminal = spawn('script', ['-q', '/dev/null', 'sleep', '30'], { stdio: 'ignore' })
    await once(terminal, 'spawn')
    for (let attempt = 0; attempt < 50 && !sleeperPid; attempt++) {
      const child = execFileSync('ps', ['-axo', 'pid=,ppid=,tty='], { encoding: 'utf8' })
        .split('\n')
        .map((line) => line.trim().split(/\s+/))
        .find((row) => Number(row[1]) === terminal.pid && row[2] !== '??')
      if (child) {
        sleeperPid = Number(child[0])
        tty = child[2]
      } else {
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
    }
    if (!sleeperPid) {
      throw new Error('fixture did not acquire a PTY')
    }
  }, 120_000)

  afterAll(async () => {
    if (terminal?.exitCode === null && terminal.signalCode === null) {
      const exited = once(terminal, 'exit')
      terminal.kill('SIGKILL')
      await exited
    }
    if (sleeperPid) {
      try {
        process.kill(sleeperPid, 'SIGKILL')
      } catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'ESRCH') {
          throw error
        }
      }
    }
    rmSync(scratch, { recursive: true, force: true })
  })

  it('exports only the resize lookup', () => {
    expect(Object.keys(addon)).toEqual(['readProcessForegroundGroup'])
  })

  it('matches ps for a fresh known terminal without warming a cache', () => {
    const line = execFileSync('ps', ['-p', String(sleeperPid), '-o', 'pid=,tpgid=,tty='], {
      encoding: 'utf8'
    }).trim()
    const [pid, tpgid, terminalName] = line.split(/\s+/)
    expect(addon.readProcessForegroundGroup(sleeperPid, `/dev/${tty}`)).toEqual({
      pid: Number(pid),
      tpgid: Number(tpgid),
      tty: terminalName
    })
    expect(addon.readProcessForegroundGroup(sleeperPid, tty)?.tty).toBe(tty)
  })

  it('refuses another device and an absent terminal', () => {
    expect(addon.readProcessForegroundGroup(sleeperPid, '/dev/null')?.tty).toBe('??')
    expect(addon.readProcessForegroundGroup(sleeperPid, 'ttys99999')?.tty).toBe('??')
    expect(addon.readProcessForegroundGroup(process.pid, tty)?.tty).toBe('??')
  })

  it('returns null for a missing process', () => {
    expect(addon.readProcessForegroundGroup(2 ** 30, tty)).toBeNull()
  })

  it.each([0, -1, 1.5, Number.NaN, Infinity, 2 ** 31, 2 ** 32 + 1, -(2 ** 32) + 1])(
    'rejects invalid pid %s without truncating or wrapping',
    (pid) =>
      expect(() => addon.readProcessForegroundGroup(pid, tty)).toThrow('expected a positive pid')
  )

  it.each([
    '',
    'x'.repeat(1024),
    'ttys003\u0000ignored',
    '../tmp',
    '/dev/../tmp',
    '/tmp/tty',
    '/dev/',
    '.',
    '..',
    'pts/3',
    '/dev/fd/0'
  ])('rejects invalid terminal %j before checking a missing process', (name) =>
    expect(() => addon.readProcessForegroundGroup(2 ** 30, name)).toThrow(
      'expected a terminal name'
    )
  )
})
