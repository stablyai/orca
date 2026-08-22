import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { findPosixShell, hasPosixShellAtCanonicalPath, posixShellEnvironment } from './posix-shell'

/** A copy of the environment with every PATH entry holding a shell removed.
 *
 *  Windows env keys are case-insensitive, so `Path` has to go too — leaving it
 *  behind would hand the child the original list under the other spelling. */
function environmentWithoutShellOnPath(): NodeJS.ProcessEnv {
  const stripped = (process.env.PATH ?? '')
    .split(delimiter)
    .filter(
      (entry) => entry && !existsSync(join(entry, 'sh.exe')) && !existsSync(join(entry, 'sh'))
    )
    .join(delimiter)
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !/^path$/i.test(name))
  )
  return { ...environment, PATH: stripped }
}

describe('findPosixShell', () => {
  it('returns a shell that can actually run a command', () => {
    const shell = findPosixShell()
    if (!shell) {
      return
    }

    expect(spawnSync(shell, ['-c', 'exit 0'], { stdio: 'ignore' }).status).toBe(0)
  })

  it('answers the same way every time, so a suite cannot half-skip', () => {
    expect(findPosixShell()).toBe(findPosixShell())
  })

  it('finds one on every platform that ships /bin/sh', () => {
    if (process.platform === 'win32') {
      return
    }

    expect(findPosixShell()).toBe('/bin/sh')
  })

  it.runIf(process.platform === 'win32')('finds one with no shell anywhere on PATH', () => {
    // Why this case: Git for Windows puts `cmd/` on PATH but not `usr/bin/`, so
    // a run started from cmd.exe or PowerShell resolves `git` and not `sh`. The
    // search answered "none" there, and eleven ssh tests failed on the spawn
    // rather than on the commands they meant to check — while passing when the
    // same suite was started from Git Bash. The answer must not depend on that.
    const environment = environmentWithoutShellOnPath()
    const onPath = spawnSync('sh', ['-c', 'exit 0'], { env: environment, stdio: 'ignore' })
    expect((onPath.error as NodeJS.ErrnoException | undefined)?.code).toBe('ENOENT')

    // Why a child process: the search caches its answer for the life of a
    // process, so the stripped PATH only means anything to a fresh one.
    const url = pathToFileURL(join(__dirname, 'posix-shell.ts')).href
    // Why the resolve hook: bare node applies ESM resolution, which rejects the
    // extensionless relative specifiers TypeScript sources are written with.
    const probe = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `import { registerHooks } from 'node:module'
         registerHooks({
           resolve(specifier, context, next) {
             try {
               return next(specifier, context)
             } catch {
               return next(specifier + '.ts', context)
             }
           }
         })
         const m = await import(${JSON.stringify(url)})
         process.stdout.write(m.findPosixShell() ?? '')`
      ],
      { encoding: 'utf8', env: environment }
    )

    expect(probe.stdout.trim(), probe.stderr).not.toBe('')
    expect(spawnSync(probe.stdout.trim(), ['-c', 'exit 0'], { stdio: 'ignore' }).status).toBe(0)
  })
})

describe('posixShellEnvironment', () => {
  it('reaches the utilities a generated script actually calls', () => {
    const shell = findPosixShell()
    if (!shell) {
      return
    }

    const probe = spawnSync(shell, ['-c', `printf 'a b\\n' | awk '{print $2}'`], {
      encoding: 'utf8',
      env: posixShellEnvironment()
    })

    expect(probe.stdout.trim()).toBe('b')
  })

  it('puts those utilities ahead of the same-named Windows ones', () => {
    const shell = findPosixShell()
    if (!shell || !isAbsolute(shell)) {
      return
    }

    // Why `find` specifically: Windows ships its own find.exe in System32, and
    // it is not remotely the same program. A script that reaches it fails
    // strangely — "File not found - relay-*" — rather than loudly.
    const resolvedFind = spawnSync(shell, ['-c', 'command -v find'], {
      encoding: 'utf8',
      env: posixShellEnvironment()
    })

    expect(resolvedFind.stdout.trim().toLowerCase()).not.toContain('system32')
  })

  it('leaves the caller’s own environment untouched', () => {
    const before = process.env.PATH

    posixShellEnvironment()

    // Why: one suite prepending Git's tools process-wide would change what
    // `find` means for every other suite sharing the worker.
    expect(process.env.PATH).toBe(before)
  })
})

describe('hasPosixShellAtCanonicalPath', () => {
  it('asks specifically about /bin/sh, not about any shell on PATH', () => {
    // Why the distinction: a test that fakes `process.platform = 'linux'` drives
    // production down paths that spawn `/bin/sh` by that exact name. Git's `sh`
    // on PATH proves nothing about whether that spawn will resolve.
    expect(hasPosixShellAtCanonicalPath()).toBe(
      spawnSync('/bin/sh', ['-c', 'exit 0'], { stdio: 'ignore' }).status === 0
    )
  })

  it('is true wherever the platform ships one', () => {
    if (process.platform === 'win32') {
      return
    }

    expect(hasPosixShellAtCanonicalPath()).toBe(true)
  })
})
