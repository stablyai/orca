import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path'

/** Where a POSIX shell is, asked by running one.
 *
 *  Tests that exercise shell command generation hardcoded `/bin/sh`, which does
 *  not exist on Windows — so they failed there on the spawn rather than on the
 *  commands they meant to check. A Git installation does ship a POSIX `sh`, and
 *  finding it lets those cases run for real instead of being skipped.
 *
 *  `ORCA_POSIX_SHELL` overrides the search, mirroring `ORCA_POWERSHELL_EXECUTABLE`. */

const CANDIDATES = ['/bin/sh', 'sh'] as const
/** exec-path sits at `<root>/mingw64/libexec/git-core`, but the depth differs
 *  between Git builds and architectures, so climb rather than count. */
const GIT_ROOT_SEARCH_DEPTH = 5

let resolved: string | null | undefined
let canonical: boolean | undefined

function runs(candidate: string): boolean {
  return spawnSync(candidate, ['-c', 'exit 0'], { stdio: 'ignore' }).status === 0
}

/** The shell inside the Git installation, found without consulting PATH for it.
 *
 *  Why this exists: Git for Windows puts `cmd/` on PATH but not `usr/bin/`, so a
 *  run started from cmd.exe or PowerShell resolves `git` and not `sh` — the same
 *  suite then answers differently depending on which shell launched it. Asking
 *  git where it lives makes the answer a property of the machine instead. */
function gitBundledShell(): string | null {
  const execPath = spawnSync('git', ['--exec-path'], { encoding: 'utf8' })
  if (execPath.status !== 0 || !execPath.stdout.trim()) {
    return null
  }
  let directory = resolve(execPath.stdout.trim())
  for (let depth = 0; depth < GIT_ROOT_SEARCH_DEPTH; depth += 1) {
    const candidate = join(directory, 'usr', 'bin', process.platform === 'win32' ? 'sh.exe' : 'sh')
    if (existsSync(candidate)) {
      return candidate
    }
    const parent = dirname(directory)
    if (parent === directory) {
      return null
    }
    directory = parent
  }
  return null
}

/** The first POSIX shell that runs here, or null when there is none. */
export function findPosixShell(): string | null {
  if (resolved !== undefined) {
    return resolved
  }
  const configured = process.env.ORCA_POSIX_SHELL?.trim()
  const candidates = configured ? [configured, ...CANDIDATES] : CANDIDATES
  const found = candidates.find((candidate) => runs(candidate))
  if (found) {
    resolved = found
    return resolved
  }
  // Why last: spawning git costs a process, and on any host that ships `/bin/sh`
  // the search is already over by the time we get here.
  const bundled = gitBundledShell()
  resolved = bundled && runs(bundled) ? bundled : null
  return resolved
}

function pathOf(environment: NodeJS.ProcessEnv): string {
  // Why not `environment.PATH`: Windows spells the key `Path`, and a plain
  // object copy of `process.env` loses the case-insensitive lookup.
  return Object.entries(environment).find(([name]) => /^path$/i.test(name))?.[1] ?? ''
}

/** Environment for spawning what `findPosixShell` found.
 *
 *  Why it is needed: a shell's utilities — awk, sed, find — sit beside it, and
 *  Git for Windows does not put that directory on PATH. Without this, a
 *  generated script either cannot find `awk` at all or, worse, reaches Windows'
 *  own `find.exe` and fails strangely instead of loudly. Prepending is
 *  deliberate: the POSIX tool has to win over the same-named Windows one.
 *
 *  Scoped to the spawn rather than applied to `process.env`, so one suite cannot
 *  change what another suite's `find` means. */
export function posixShellEnvironment(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const existing = pathOf(base)
  const environment: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(base).filter(([name]) => !/^path$/i.test(name))
  )
  const shell = findPosixShell()
  // A bare `sh` came off PATH already, so its directory is on there too.
  if (!shell || !isAbsolute(shell)) {
    environment.PATH = existing
    return environment
  }
  const directory = dirname(shell)
  environment.PATH = existing.split(delimiter).includes(directory)
    ? existing
    : `${directory}${delimiter}${existing}`
  return environment
}

/** Whether `/bin/sh` itself resolves, by that exact name.
 *
 *  A separate question from `findPosixShell`: a suite that fakes
 *  `process.platform = 'linux'` sends production down paths that spawn
 *  `/bin/sh` literally, and Git's `sh` does nothing for those. */
export function hasPosixShellAtCanonicalPath(): boolean {
  canonical ??= runs('/bin/sh')
  return canonical
}
