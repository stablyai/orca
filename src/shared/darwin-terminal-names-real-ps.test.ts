import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { lstat } from 'node:fs/promises'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { nameDarwinTerminals } from './darwin-terminal-names'
import { PS_ARGS } from './process-table-snapshot'

const RAW_ARGS = ['-axo', PS_ARGS[1].replace('tty=', 'tdev=')]

function rowsByPid(stdout: string): Map<string, string> {
  return new Map(
    stdout
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => [line.trim().split(/\s+/)[0], line])
  )
}

function ttyByPid(stdout: string): Map<string, string> {
  return new Map([...rowsByPid(stdout)].map(([pid, row]) => [pid, row.trim().split(/\s+/)[5]]))
}

describe.runIf(process.platform === 'darwin')('nameDarwinTerminals against real ps', () => {
  let holder: ChildProcess | undefined
  let terminalPid = ''

  beforeAll(async () => {
    // `script` gives its child a real pty, so a headless host still has one named terminal.
    holder = spawn('script', ['-q', '/dev/null', 'sleep', '30'], { stdio: 'ignore' })
    for (let attempt = 0; attempt < 100 && !terminalPid; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20))
      try {
        terminalPid = execFileSync('pgrep', ['-P', String(holder.pid)], { encoding: 'utf8' }).trim()
      } catch {
        // No child yet.
      }
    }
  })
  afterAll(() => {
    holder?.kill()
  })

  it('names a real pty through the direct lookup without scanning /dev', async () => {
    const row = rowsByPid(execFileSync('ps', RAW_ARGS, { encoding: 'utf8' })).get(terminalPid)
    expect(row).toBeDefined()
    const named = await nameDarwinTerminals(`${row}\n`, {
      openDirectory: () => Promise.reject(new Error('direct lookup must not scan /dev')),
      readDevice: (path) => lstat(path, { bigint: true })
    })
    expect(ttyByPid(named).get(terminalPid)).toBe(
      ttyByPid(execFileSync('ps', [...PS_ARGS], { encoding: 'utf8' })).get(terminalPid)
    )
    expect(ttyByPid(named).get(terminalPid)).toMatch(/^ttys\d{3,}$/)
  })

  it('matches ps terminal names for every process present in both captures', async () => {
    // Retry once: a terminal can close between the two ps runs.
    let mismatches: string[] = []
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const raw = execFileSync('ps', RAW_ARGS, { encoding: 'utf8' })
      const canonical = ttyByPid(execFileSync('ps', [...PS_ARGS], { encoding: 'utf8' }))
      const named = ttyByPid(await nameDarwinTerminals(raw))
      mismatches = [...named]
        .filter(([pid, tty]) => canonical.has(pid) && canonical.get(pid) !== tty)
        .map(([pid, tty]) => `${pid}: ${tty} != ${canonical.get(pid)}`)
      if (mismatches.length === 0) {
        break
      }
    }
    expect(mismatches).toEqual([])
  })
})
