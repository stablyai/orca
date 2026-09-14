import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runProcess } from './run-process'
import { RELAY_LSOF_PROBE_JS } from './posix-lsof-probe'

// Keep group evidence deterministic when the host immediately reaps orphaned helpers.
const PRELOAD = String.raw`
var cp = require('child_process');
var fs = require('fs');
var spawn = cp.spawn;
var kill = process.kill.bind(process);
var lsofPid;
var censusPid;
cp.spawn = function(program, args, options) {
  var child = spawn(program, args, options);
  if (program === 'lsof') {
    lsofPid = child.pid;
    fs.writeFileSync(process.env.PROBE_PID, String(child.pid));
    if (process.env.STARTUP_SIGNAL) {
      kill(process.pid, process.env.STARTUP_SIGNAL);
      var end = Date.now() + 100;
      while (Date.now() < end) {}
    }
  }
  if (program === 'ps') {
    censusPid = child.pid;
    fs.writeFileSync(process.env.PS_PID, String(child.pid));
  }
  return child;
};
process.kill = function(pid, signal) {
  if (process.env.CENSUS_KILL_DENIED && pid === -censusPid && signal === 'SIGKILL') {
    var error = new Error('fixture census kill denied');
    error.code = 'EPERM';
    throw error;
  }
  if (process.env.GROUP_STILL_EXISTS && pid === -lsofPid && signal === 0) {
    if (process.env.CENSUS_KILL_DENIED && censusPid) return kill(pid, signal);
    return true;
  }
  return kill(pid, signal);
};
`

async function runProbe(options: { signal?: string; census?: string; censusKillDenied?: boolean }) {
  const dir = mkdtempSync(join(tmpdir(), 'orca-lsof-lifecycle-'))
  const pidFile = join(dir, 'lsof.pid')
  const psPidFile = join(dir, 'ps.pid')
  try {
    writeFileSync(join(dir, 'preload.cjs'), PRELOAD)
    writeFileSync(
      join(dir, 'lsof'),
      `#!/bin/sh\necho 123\n${options.signal ? 'exec sleep 60\n' : 'exit 2\n'}`,
      { mode: 0o755 }
    )
    if (options.census !== undefined) {
      writeFileSync(join(dir, 'ps'), `#!/bin/sh\n${options.census}`, { mode: 0o755 })
    }
    const started = performance.now()
    const result = await runProcess({
      program: process.execPath,
      args: ['--require', join(dir, 'preload.cjs'), '-e', RELAY_LSOF_PROBE_JS, '/unused.sock'],
      env: {
        ...process.env,
        ORCA_BACKGROUND_LAUNCH: '1',
        PATH: `${dir}:${process.env.PATH}`,
        PROBE_PID: pidFile,
        PS_PID: psPidFile,
        STARTUP_SIGNAL: options.signal ?? '',
        GROUP_STILL_EXISTS: options.census === undefined ? '' : '1',
        CENSUS_KILL_DENIED: options.censusKillDenied ? '1' : ''
      },
      timeoutMs: 10000,
      detached: true,
      terminationBarrier: true
    })
    for (const file of [pidFile, psPidFile]) {
      let pid: string
      try {
        pid = readFileSync(file, 'utf8')
      } catch {
        continue
      }
      const state = await runProcess({
        program: 'ps',
        args: ['-o', 'state=', '-p', pid],
        timeoutMs: 2000
      })
      expect(
        (state.code === 1 && !state.stdout.trim()) ||
          (state.code === 0 && state.stdout.trim().startsWith('Z'))
      ).toBe(true)
    }
    if (options.censusKillDenied) {
      expect(process.kill(-Number(readFileSync(psPidFile, 'utf8')), 0)).toBe(true)
    }
    return { ...result, elapsedMs: performance.now() - started }
  } finally {
    for (const file of [pidFile, psPidFile]) {
      try {
        const pid = Number(readFileSync(file, 'utf8'))
        if (Number.isSafeInteger(pid) && pid > 0) {
          process.kill(-pid, 'SIGKILL')
        }
      } catch {}
    }
    rmSync(dir, { recursive: true, force: true })
  }
}

describe.skipIf(process.platform === 'win32')('lsof supervisor lifecycle', () => {
  it.each(['SIGTERM', 'SIGHUP', 'SIGINT'])(
    'owns lsof when %s arrives inside spawn',
    async (signal) => {
      const result = await runProbe({ signal })
      expect(result).toMatchObject({ code: 0, signal: null, timedOut: false })
      expect(result.stdout.split('\n')[0]).toBe('unavailable')
    }
  )

  it('accepts zombie-only group evidence after the direct child closes', async () => {
    const result = await runProbe({ census: 'printf "%s Z\\n" "$(cat "$PROBE_PID")"\n' })
    expect(result.stdout).toBe('unavailable\n123\n')
    expect(result.timedOut).toBe(false)
  })

  it('requires census cleanup even when the lsof group disappears', async () => {
    const result = await runProbe({
      census: 'sleep 60 </dev/null >/dev/null 2>&1 &\nexit 0\n',
      censusKillDenied: true
    })
    expect(result.stdout).toBe('cleanup-unconfirmed\n123\n')
    expect(result).toMatchObject({ code: 0, signal: null, timedOut: false })
  })

  it.each([
    ['live member', 'printf "%s S\\n" "$(cat "$PROBE_PID")"\n'],
    ['failed census', 'exit 1\n'],
    ['missing group', 'printf "1 Z\\n"\n'],
    ['empty census', 'exit 0\n'],
    ['malformed census', 'echo malformed\n'],
    ['incomplete record', 'printf "%s Z" "$(cat "$PROBE_PID")"\n'],
    ['hung census', 'echo $$ > "$PS_PID"\nexec sleep 60\n'],
    ['oversized census', 'head -c 9000000 /dev/zero\n']
  ])('keeps cleanup unconfirmed for %s', async (_name, census) => {
    const result = await runProbe({ census })
    expect(result.stdout).toBe('cleanup-unconfirmed\n123\n')
    expect(result).toMatchObject({ code: 0, signal: null, timedOut: false })
    expect(result.elapsedMs).toBeLessThan(4000)
  })
})
