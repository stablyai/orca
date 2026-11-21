/**
 * Diagnostics for the E9 WSL guard: a JSON-lines log of every spawn, plus main-process filesystem
 * touches of a `\\wsl.localhost` path, each with its time and caller stack, so a boot the
 * running-list watcher sees can be matched to the act that caused it. Test harness only: installed
 * into an e2e-mode app through Playwright, never imported by shipped code.
 */
import { existsSync, readFileSync } from 'node:fs'
import type { ElectronApplication } from '@stablyai/playwright-test'

/** `file` is the launched program, or `fs` for a filesystem touch whose `args` are [method, path]. */
export type DiagnosticRecord = { file: string; args: string[]; at?: number; stack?: string[] }

export const UNC_TOUCH = 'fs'
/** A terminal spawn: node-pty launches outside main's child_process, so main's per-spawn history log line stands in. */
export const PTY_SPAWN = 'pty'

/**
 * Logs main's direct child_process spawns (spawn, exec and execFile all pass through
 * ChildProcess#spawn) and its fs touches of WSL UNC paths, beside the process-host log. node-pty
 * terminals spawn elsewhere and need not be logged.
 */
export async function recordMainProcessWslDiagnostics(
  app: ElectronApplication,
  logFile: string
): Promise<void> {
  await app.evaluate((_electron, logFile) => {
    // Never patch fs or capture stacks in an app that is not in e2e mode.
    if (!process.env.ORCA_E2E_USER_DATA_DIR || !process.env.ORCA_E2E_SPAWN_LOG) {
      throw new Error('WSL boot diagnostics need an e2e-mode app with the spawn log named')
    }
    const fs = process.mainModule?.require('node:fs')
    const proto = process.mainModule?.require('node:child_process')?.ChildProcess?.prototype
    if (!fs || !proto) {
      throw new Error('Cannot hook child_process in the main process')
    }
    if (proto.spawn.orcaE9SpawnLog) {
      return
    }
    const append = (file: string, args: unknown[]): void => {
      // Deep enough to reach the IPC handler past async hops; node internals add nothing.
      const limit = Error.stackTraceLimit
      Error.stackTraceLimit = 60
      const raw = new Error('e9 diagnostics caller').stack ?? ''
      Error.stackTraceLimit = limit
      const stack = raw
        .split('\n')
        .slice(3)
        .map((line) => line.trim())
        .filter((line) => !/\((node:|<anonymous>)|^at (new Promise|process\.)/.test(line))
        .slice(0, 30)
      fs.appendFileSync(
        logFile,
        `${JSON.stringify({ file, args: args.map(String), at: Date.now(), stack })}\n`
      )
    }
    const original = proto.spawn
    const logged = function (this: unknown, options: { file?: string; args?: string[] }) {
      append(String(options?.file ?? ''), options?.args ?? [])
      return original.call(this, options)
    }
    logged.orcaE9SpawnLog = true
    proto.spawn = logged

    // Every daemon or local PTY spawn with a worktree logs this line first (logHistoryInjection).
    const originalLog = console.log
    console.log = function (this: unknown, ...args: unknown[]) {
      if (typeof args[0] === 'string' && args[0].startsWith('[pty:history] ')) {
        // Keep in sync with PTY_SPAWN; evaluate cannot see module constants.
        append('pty', [args[0]])
      }
      return originalLog.apply(this, args)
    }

    const isWslUnc = (value: unknown): boolean =>
      /^([\\/]{2})(wsl\.localhost|wsl\$)[\\/]/i.test(
        typeof value === 'string' ? value : value instanceof URL ? value.pathname : ''
      )
    const wrap = (target: Record<string, unknown>, prefix: string, names: string[]): void => {
      for (const name of names) {
        const fn = target[name]
        if (typeof fn !== 'function') {
          continue
        }
        const wrapped = function (this: unknown, ...args: unknown[]) {
          if (isWslUnc(args[0])) {
            append('fs', [`${prefix}${name}`, args[0]])
          }
          return fn.apply(this, args)
        }
        // Keep attached members such as `realpathSync.native`.
        target[name] = Object.assign(wrapped, fn)
      }
    }
    const methods = [
      'stat',
      'lstat',
      'access',
      'readFile',
      'readdir',
      'realpath',
      'open',
      'opendir'
    ]
    wrap(fs, 'fs.', [...methods, ...methods.map((name) => `${name}Sync`), 'existsSync', 'watch'])
    wrap(fs.promises, 'fs.promises.', [...methods, 'writeFile', 'mkdir'])
  }, logFile)
}

export function readDiagnosticLog(logFile: string): DiagnosticRecord[] {
  if (!existsSync(logFile)) {
    return []
  }
  return readFileSync(logFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((line): DiagnosticRecord[] => {
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        // A line torn by a concurrent append; the next read sees it whole.
        return []
      }
      if (!parsed || typeof parsed !== 'object') {
        return []
      }
      const file = 'file' in parsed ? String(parsed.file) : ''
      const args = 'args' in parsed && Array.isArray(parsed.args) ? parsed.args.map(String) : []
      const at = 'at' in parsed && typeof parsed.at === 'number' ? parsed.at : undefined
      const stack =
        'stack' in parsed && Array.isArray(parsed.stack) ? parsed.stack.map(String) : undefined
      return [{ file, args, ...(at === undefined ? {} : { at }), ...(stack ? { stack } : {}) }]
    })
}
