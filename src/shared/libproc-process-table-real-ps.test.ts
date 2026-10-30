import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { setLibprocAddonForTests, type LibprocAddon } from './libproc-addon'
import { runPsInProcess } from './libproc-process-table'
import { CHEAP_PS_ARGS, PS_ARGS, SHELL_FOREGROUND_PS_ARGS } from './process-table-snapshot'

const C_UTC = { ...process.env, LC_ALL: 'C', LANG: 'C', TZ: 'UTC0' }
const UTF8 = { ...process.env, LC_ALL: 'en_US.UTF-8' }
// Argv ps must vis-encode: newline, tab, invalid UTF-8, a lone continuation byte, and UTF-8 é.
const HOLDER_SCRIPT =
  'exec {"/usr/bin/perl"} "perl", "-e", "sleep 30", "a\\nb", "c\\td", "bad\\xff\\xfeutf", "\\x80", "\\xc3\\xa9"'

function loadRealAddon(): LibprocAddon {
  const utils = createRequire(__filename)('node-pty/lib/utils')
  return utils.loadNativeModule('pty').module
}

function columnsOf(args: readonly string[]): string[] {
  const spec = args[args.findIndex((arg) => arg === '-o' || arg === '-axo') + 1]
  return spec.split(',').map((field) => field.replace('=', ''))
}

const LSTART = String.raw`\S+\s+\S+\s+\d+\s+\d+:\d+:\d+\s+\d+`

/** Rows keyed by pid; `stat` folds running/idle/uninterruptible into sleeping since thread states need setuid ps. */
function rowsOf(stdout: string, columns: readonly string[]): Map<number, string[]> {
  const pattern = new RegExp(
    `^\\s*${columns
      .map((column) =>
        column === 'lstart' ? `(${LSTART})` : column === 'command' ? '(.*)' : '(\\S+)'
      )
      .join('\\s+')}\\s*$`
  )
  const rows = new Map<number, string[]>()
  for (const line of stdout.split('\n').filter((entry) => entry.trim())) {
    const match = pattern.exec(line)
    expect(match, line).not.toBeNull()
    const fields = match!
      .slice(1)
      .map((field, index) =>
        columns[index] === 'stat'
          ? field.replace(/^[RSIU?]/, 'S')
          : columns[index] === 'lstart'
            ? field.replace(/\s+/g, ' ')
            : field
      )
    rows.set(Number(fields[columns.indexOf('pid')]), fields)
  }
  return rows
}

async function inProcess(args: readonly string[], env: NodeJS.ProcessEnv): Promise<string> {
  const result = await runPsInProcess(args, { env, timeoutMs: 5000 })
  expect(result?.timedOut).toBe(false)
  return result!.stdout
}

describe.runIf(process.platform === 'darwin')(
  'runPsInProcess with the real addon against /bin/ps',
  // Each case runs whole-table /bin/ps with command= (~1-3s alone, longer when the suite loads the host).
  { timeout: 30_000 },
  () => {
    let holder: ChildProcess | undefined
    let holderPid = 0
    let holderTty = ''
    let ownPids = new Set<number>()

    beforeAll(async () => {
      setLibprocAddonForTests(loadRealAddon())
      // `script` gives the holder a real pty, so a headless host still has a terminal to select.
      holder = spawn('script', ['-q', '/dev/null', 'perl', '-e', HOLDER_SCRIPT], {
        stdio: 'ignore'
      })
      await vi.waitFor(
        () => {
          holderPid = Number(
            execFileSync('pgrep', ['-P', String(holder!.pid)], { encoding: 'utf8' })
          )
          const command = execFileSync('ps', ['-o', 'command=', '-p', String(holderPid)], {
            encoding: 'utf8'
          })
          expect(command).toContain('sleep 30 a')
          holderTty = execFileSync('ps', ['-o', 'tty=', '-p', String(holderPid)], {
            encoding: 'utf8'
          }).trim()
        },
        { timeout: 5000, interval: 20 }
      )
      const uid = String(process.getuid?.())
      ownPids = new Set(
        execFileSync('ps', ['-axo', 'pid=,uid='], { encoding: 'utf8' })
          .split('\n')
          .map((line) => line.trim().split(/\s+/))
          .filter(([, owner]) => owner === uid)
          .map(([pid]) => Number(pid))
      )
    })
    afterAll(() => {
      holder?.kill()
      setLibprocAddonForTests(undefined)
    })

    /** Read ours, ps, ours: a row is compared only when both of ours agree, so processes changing mid-read cannot flake. */
    async function mismatches(args: readonly string[], env: NodeJS.ProcessEnv): Promise<string[]> {
      const columns = columnsOf(args)
      const before = rowsOf(await inProcess(args, env), columns)
      const ps = rowsOf(execFileSync('/bin/ps', [...args], { encoding: 'utf8', env }), columns)
      const after = rowsOf(await inProcess(args, env), columns)
      const commandAt = columns.indexOf('command')
      const failures: string[] = []
      const shared: number[] = []
      for (const [pid, ours] of before) {
        const real = ps.get(pid)
        if (!real || JSON.stringify(after.get(pid)) !== JSON.stringify(ours)) {
          continue
        }
        shared.push(pid)
        // Another user's argv needs setuid ps; only pane descendants get that fallback.
        const comparable =
          commandAt === -1 || ownPids.has(pid)
            ? ours
            : ours.filter((_, index) => index !== commandAt)
        const expected =
          commandAt === -1 || ownPids.has(pid)
            ? real
            : real.filter((_, index) => index !== commandAt)
        if (JSON.stringify(comparable) !== JSON.stringify(expected)) {
          failures.push(`${pid}: ${JSON.stringify(comparable)} != ${JSON.stringify(expected)}`)
        }
      }
      // ps sorts by terminal, then pid; parsers that take the first match rely on that order.
      const comparedPids = new Set(shared)
      const psOrder = [...ps.keys()].filter((pid) => comparedPids.has(pid))
      if (JSON.stringify(psOrder) !== JSON.stringify(shared)) {
        failures.push(`row order differs from ps for ${args.join(' ')}`)
      }
      return failures
    }

    it('finds the holder on its terminal', () => {
      expect(holderTty).toMatch(/^ttys\d+$/)
    })

    it.each([
      ['full snapshot', PS_ARGS, UTF8],
      ['full snapshot (tdev)', ['-axo', PS_ARGS[1].replace('tty=', 'tdev=')], UTF8],
      ['cheap snapshot', CHEAP_PS_ARGS, UTF8],
      ['shell foreground', SHELL_FOREGROUND_PS_ARGS, UTF8],
      ['descendant termination', ['-axo', 'pid=,ppid=,pgid=,tpgid=,lstart='], C_UTC]
    ])('matches ps for the %s table', async (_name, args, env) => {
      expect(await mismatches(args, env)).toEqual([])
    })

    it('matches ps for pid and terminal selections, escaping argv in each locale', async () => {
      const pids = `${holderPid},${holderPid},${process.pid},1`
      for (const env of [UTF8, C_UTC]) {
        expect(await mismatches(['-p', pids, '-o', PS_ARGS[1]], env)).toEqual([])
        expect(await mismatches(['-p', pids, '-o', 'pid=,tpgid=,tty='], env)).toEqual([])
        expect(
          await mismatches(['-o', 'pid=,ppid=,pgid=,tpgid=,stat=,command=', '-t', holderTty], env)
        ).toEqual([])
        const holder = await inProcess(['-o', 'command=', '-p', `${holderPid},${holderPid}`], env)
        expect(holder).toBe(
          execFileSync('/bin/ps', ['-o', 'command=', '-p', String(holderPid)], {
            encoding: 'utf8',
            env
          })
        )
        expect(holder).toContain(String.raw`a\012b c\011d`)
      }
    })
  }
)
