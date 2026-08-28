import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseDarwinExecutablePath, resolveShellExecutablePath } from './shell-process-readiness'

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
})
