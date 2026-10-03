import { afterEach, describe, expect, it } from 'vitest'
import { runProcess, spawnProcess } from './child-process/run-process'
import { readAgentProcess } from './agent-process-presence-probe'
import { processTableEnv } from './process-table-snapshot-reader'

const children: { kill: () => boolean }[] = []
afterEach(() => {
  for (const child of children.splice(0)) {
    child.kill()
  }
})

async function psRow(pid: number, columns: string, env: NodeJS.ProcessEnv): Promise<string> {
  const result = await runProcess({
    program: 'ps',
    args: ['-p', String(pid), '-o', columns],
    env: processTableEnv(env),
    timeoutMs: 5_000,
    maxOutputBytes: 4096
  })
  return result.stdout.trim()
}

describe.runIf(process.platform === 'darwin')('Darwin process table locale', () => {
  it('prints the same instant for the table and the identity read, whatever the user locale and zone', async () => {
    const table = await psRow(process.pid, 'lstart=', {
      ...process.env,
      LC_ALL: 'zh_CN.UTF-8',
      TZ: 'Asia/Shanghai'
    })
    const identity = await readAgentProcess(process.pid)
    expect(identity.verdict).toBe('live')
    const tableAt = Date.parse(`${table} UTC`)
    expect(Number.isFinite(tableAt)).toBe(true)
    expect(tableAt).toBe(
      identity.verdict === 'live' ? Date.parse(`${identity.startTime} UTC`) : Number.NaN
    )
  })

  it.each([
    { LC_ALL: 'en_US.UTF-8', LANG: 'en_US.utf8' },
    { LC_ALL: 'en_US.UTF-8', LC_MESSAGES: 'xx_YY.bogus' }
  ])('keeps non-ASCII command text when another locale variable is not installed: %o', async (locale) => {
    const child = spawnProcess({
      program: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 10_000)', 'dïr-ü'],
      env: { PATH: process.env.PATH }
    })
    children.push(child)
    const pid = child.pid ?? 0
    expect(pid).toBeGreaterThan(0)
    const env = { PATH: process.env.PATH, ...locale }
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if ((await psRow(pid, 'command=', env)).includes('dïr')) {
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    expect(await psRow(pid, 'command=', env)).toContain('dïr-ü')
  })
})
