import type * as NodeChildProcess from 'node:child_process'
import type * as NodeFsPromises from 'node:fs/promises'
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  parseDarwinExecutablePath,
  readRelayedShellReadiness,
  resolveInstalledShellExecutablePaths,
  resolveShellExecutablePath
} from './shell-process-readiness'

const execFileCallbackMock = vi.hoisted(() => vi.fn())
const readlinkMock = vi.hoisted(() => vi.fn())
const realpathMock = vi.hoisted(() => vi.fn())

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof NodeChildProcess>()),
  execFile: execFileCallbackMock
}))
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof NodeFsPromises>()),
  readlink: readlinkMock,
  realpath: realpathMock
}))

// The mocked fs members fall back to their real implementations unless a test stages them.
beforeEach(async () => {
  execFileCallbackMock.mockReset()
  const actual = await vi.importActual<typeof NodeFsPromises>('node:fs/promises')
  readlinkMock.mockReset().mockImplementation(actual.readlink)
  realpathMock.mockReset().mockImplementation(actual.realpath)
})

describe('shell process readiness', () => {
  it('extracts the primary text image from macOS lsof output', () => {
    expect(parseDarwinExecutablePath('p42\nftxt\nn/bin/zsh\nftxt\nn/usr/lib/zsh/zle.so\n')).toBe(
      '/bin/zsh'
    )
  })

  it.skipIf(process.platform === 'win32')(
    'resolves bare shell commands through the spawn PATH',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'orca-shell-path-'))
      const link = join(root, 'shell-name')
      await symlink(process.execPath, link)
      try {
        await expect(resolveShellExecutablePath('shell-name', dirname(root), root)).resolves.toBe(
          await resolveShellExecutablePath(process.execPath, dirname(root), root)
        )
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  )

  it.skipIf(process.platform === 'win32')(
    'uses the POSIX exec default when PATH is unset',
    async () => {
      await expect(resolveShellExecutablePath('sh', process.cwd(), undefined)).resolves.toBe(
        await resolveShellExecutablePath('/bin/sh', process.cwd(), '')
      )
    }
  )

  it.skipIf(process.platform === 'win32')(
    'resolves relative shell paths against the PTY cwd',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'orca-relative-shell-'))
      const bin = join(root, 'bin')
      await symlink(dirname(process.execPath), bin)
      try {
        await expect(
          resolveShellExecutablePath(`./bin/${basename(process.execPath)}`, root, '')
        ).resolves.toBe(await resolveShellExecutablePath(process.execPath, root, ''))
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  )

  it.skipIf(process.platform === 'win32')(
    'skips searchable directories that shadow a later PATH executable',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'orca-shadowed-shell-'))
      const first = join(root, 'first')
      const second = join(root, 'second')
      await mkdir(join(first, 'shell-name'), { recursive: true })
      await mkdir(second)
      await symlink(process.execPath, join(second, 'shell-name'))
      try {
        await expect(
          resolveShellExecutablePath('shell-name', root, `${first}:${second}`)
        ).resolves.toBe(await resolveShellExecutablePath(process.execPath, root, ''))
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  )

  it.skipIf(process.platform === 'win32')(
    'lists every PATH installation of a shell name, deduplicated and canonical',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'orca-installed-shells-'))
      const first = join(root, 'first')
      const second = join(root, 'second')
      const missing = join(root, 'missing')
      await mkdir(first)
      await mkdir(second)
      await symlink(process.execPath, join(first, 'shell-name'))
      await symlink(process.execPath, join(second, 'shell-name'))
      try {
        const canonical = await resolveShellExecutablePath(process.execPath, root, '')
        await expect(
          resolveInstalledShellExecutablePaths('shell-name', root, `${first}:${missing}:${second}`)
        ).resolves.toEqual([canonical])
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  )

  it.skipIf(process.platform === 'win32')(
    'omits a same-name executable that no PATH entry reaches',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'orca-offpath-shell-'))
      const onPath = join(root, 'bin')
      const offPath = join(root, 'dropped')
      await mkdir(onPath)
      await mkdir(offPath)
      await symlink(process.execPath, join(onPath, 'shell-name'))
      await symlink(process.execPath, join(offPath, 'shell-name'))
      try {
        await expect(
          resolveInstalledShellExecutablePaths('shell-name', root, onPath)
        ).resolves.not.toContain(join(offPath, 'shell-name'))
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  )
})

describe('readRelayedShellReadiness', () => {
  type ExecFileCallback = (error: Error | null, value?: { stdout: string }) => void

  it.skipIf(process.platform === 'win32')(
    'keeps scanning when a listed relay child exits before its probes run',
    async () => {
      const foregroundPid = 4242
      const dyingPid = 900
      const livePid = 901
      const relayedTtyPath = '/dev/ttys011'
      execFileCallbackMock.mockImplementation(
        (file: string, args: string[], _options: unknown, callback: ExecFileCallback) => {
          if (file === 'ps' && args[0] === '-axo') {
            callback(null, {
              stdout: `  ${dyingPid}  ${foregroundPid}\n  ${livePid}  ${foregroundPid}\n`
            })
            return
          }
          // The exited child: `ps -p` on a gone pid fails, like the race it models.
          if (file === 'ps' && args[1] === String(dyingPid)) {
            callback(new Error(`ps: no such process: ${dyingPid}`))
            return
          }
          if (file === 'ps' && args[1] === String(livePid)) {
            callback(null, { stdout: 'S+ ttys011\n' })
            return
          }
          if (file === '/usr/sbin/lsof') {
            callback(null, { stdout: `p${livePid}\nftxt\nn${process.execPath}\n` })
            return
          }
          callback(new Error(`unexpected execFile invocation: ${file} ${args.join(' ')}`))
        }
      )
      readlinkMock.mockImplementation(async (path: string) => {
        if (path === `/proc/${livePid}/exe`) {
          return process.execPath
        }
        throw new Error(`unexpected readlink: ${path}`)
      })
      realpathMock.mockImplementation(async (path: string) => path)

      await expect(
        readRelayedShellReadiness({
          foregroundPid,
          shellPath: process.execPath,
          shellName: basename(process.execPath).toLowerCase(),
          shellCwd: process.cwd(),
          shellPathEnv: ''
        })
      ).resolves.toEqual({ ttyPath: relayedTtyPath })
    }
  )
})
