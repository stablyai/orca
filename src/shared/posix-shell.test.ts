import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { findPosixShell, hasPosixShellAtCanonicalPath, posixShellEnvironment } from './posix-shell'

function holdsShell(directory: string): boolean {
  return existsSync(join(directory, 'sh.exe')) || existsSync(join(directory, 'sh'))
}

/** The given PATH with every shell removed — and nothing else.
 *
 *  Dropping the whole directory is too blunt: Git for Windows' `bin` holds
 *  git.exe beside sh.exe, so a plain filter takes git too and the search under
 *  test has nothing left to ask. The sibling `cmd` is that same git without a
 *  shell, which is the layout this case is simulating in the first place. */
function pathWithoutShell(entries: readonly string[]): string {
  const kept: string[] = []
  for (const entry of entries) {
    if (!entry) {
      continue
    }
    if (!holdsShell(entry)) {
      kept.push(entry)
      continue
    }
    const shellFreeGit = join(dirname(entry), 'cmd')
    if (existsSync(join(shellFreeGit, 'git.exe')) && !holdsShell(shellFreeGit)) {
      kept.push(shellFreeGit)
    }
  }
  return kept.join(delimiter)
}

/** A copy of the environment with every PATH entry holding a shell removed.
 *
 *  Windows env keys are case-insensitive, so `Path` has to go too — leaving it
 *  behind would hand the child the original list under the other spelling. */
function environmentWithoutShellOnPath(): NodeJS.ProcessEnv {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !/^path$/i.test(name))
  )
  return { ...environment, PATH: pathWithoutShell((process.env.PATH ?? '').split(delimiter)) }
}

/** Resolved at collection so a host with no shell skips these cases loudly, rather
 *  than running them to a bare `return` and reporting a pass that asserted nothing.
 *  `shellPath` is only ever '' in the runs those guards already skipped. */
const shell = findPosixShell()
const shellPath = shell ?? ''
const itWithShell = it.runIf(shell !== null)

describe('findPosixShell', () => {
  itWithShell('returns a shell that can actually run a command', () => {
    expect(spawnSync(shellPath, ['-c', 'exit 0'], { stdio: 'ignore' }).status).toBe(0)
  })

  it('answers the same way every time, so a suite cannot half-skip', () => {
    expect(findPosixShell()).toBe(findPosixShell())
  })

  it.skipIf(process.platform === 'win32')('finds one on every platform that ships /bin/sh', () => {
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
    if (spawnSync('git', ['--version'], { env: environment, stdio: 'ignore' }).error) {
      // The search's last resort is asking git where it lives, and this host
      // has no git reachable with every shell taken off PATH.
      return
    }

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
             } catch (error) {
               // Only an unresolved specifier earns the retry, and a genuinely
               // missing module is reported under the name the source wrote --
               // not under a '.ts' path nobody ever meant to create.
               if (error?.code !== 'ERR_MODULE_NOT_FOUND') {
                 throw error
               }
               try {
                 return next(specifier + '.ts', context)
               } catch {
                 throw error
               }
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

  it('takes the shell off PATH without taking git with it', () => {
    // Git for Windows' `bin` holds git.exe and sh.exe together, so filtering the
    // directory out drops git as well and the case above has nothing left to
    // ask -- on a machine where both the shell and git are perfectly healthy.
    const root = mkdtempSync(join(tmpdir(), 'orca-posix-shell-path-'))
    try {
      const bin = join(root, 'bin')
      const cmd = join(root, 'cmd')
      mkdirSync(bin)
      mkdirSync(cmd)
      for (const file of [join(bin, 'git.exe'), join(bin, 'sh.exe'), join(cmd, 'git.exe')]) {
        writeFileSync(file, '')
      }

      expect(pathWithoutShell([bin]).split(delimiter)).toEqual([cmd])
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
    }
  })
})

describe('posixShellEnvironment', () => {
  itWithShell('reaches the utilities a generated script actually calls', () => {
    const probe = spawnSync(shellPath, ['-c', `printf 'a b\\n' | awk '{print $2}'`], {
      encoding: 'utf8',
      env: posixShellEnvironment()
    })

    expect(probe.stdout.trim()).toBe('b')
  })

  // A bare `sh` off PATH gives the environment no directory to prepend.
  it.runIf(shell !== null && isAbsolute(shell))(
    'puts those utilities ahead of the same-named Windows ones',
    () => {
      // Why `find` specifically: Windows ships its own find.exe in System32, and
      // it is not remotely the same program. A script that reaches it fails
      // strangely — "File not found - relay-*" — rather than loudly.
      const resolvedFind = spawnSync(shellPath, ['-c', 'command -v find'], {
        encoding: 'utf8',
        env: posixShellEnvironment()
      })

      expect(resolvedFind.stdout.trim().toLowerCase()).not.toContain('system32')
    }
  )

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

  it.skipIf(process.platform === 'win32')('is true wherever the platform ships one', () => {
    expect(hasPosixShellAtCanonicalPath()).toBe(true)
  })
})
