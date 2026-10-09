import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { psLocaleEnvironment } from './ps-locale-environment'

const US_LSTART = /^\w{3} \w{3} [ \d]\d \d\d:\d\d:\d\d \d{4}$/

describe('psLocaleEnvironment', () => {
  const user = {
    PATH: '/usr/bin:/bin',
    LANG: 'en_NZ.UTF-8',
    LC_ALL: 'pl_PL.UTF-8',
    LC_TIME: 'de_DE.UTF-8',
    LC_MESSAGES: 'C'
  }

  it('pins one uniform UTF-8 locale on macOS and keeps everything else', () => {
    expect(psLocaleEnvironment(user, 'darwin')).toEqual({
      PATH: '/usr/bin:/bin',
      LC_ALL: 'en_US.UTF-8'
    })
  })

  it('pins only LC_TIME on Linux, keeping the character set LC_ALL chose', () => {
    expect(psLocaleEnvironment(user, 'linux')).toEqual({
      PATH: '/usr/bin:/bin',
      LANG: 'en_NZ.UTF-8',
      LC_CTYPE: 'pl_PL.UTF-8',
      LC_TIME: 'C',
      LC_MESSAGES: 'C'
    })
    expect(psLocaleEnvironment({ LANG: 'de_DE.UTF-8' }, 'linux')).toEqual({
      LANG: 'de_DE.UTF-8',
      LC_TIME: 'C'
    })
  })

  it('leaves Windows alone, which has no ps', () => {
    expect(psLocaleEnvironment(user, 'win32')).toBe(user)
  })
})

describe.runIf(process.platform === 'darwin')('macOS ps under a non-US locale', () => {
  let child: ChildProcess
  beforeAll(async () => {
    // A process whose argv carries non-ASCII, which the C locale would mangle.
    child = spawn('/bin/bash', ['-c', 'exec -a "orca-ł-日本" sleep 30'], { stdio: 'ignore' })
    await new Promise((resolve) => setTimeout(resolve, 300))
  })
  afterAll(() => {
    child.kill('SIGKILL')
  })

  function read(env: NodeJS.ProcessEnv): { lstart: string; command: string } {
    const line = execFileSync('ps', ['-o', 'lstart=,command=', '-p', String(child.pid)], {
      encoding: 'utf8',
      env
    }).trim()
    const match = /^(.+? \d{4})\s+(.*)$/.exec(line)
    return { lstart: match?.[1] ?? '', command: match?.[2] ?? '' }
  }

  it.each([
    { LANG: 'en_NZ.UTF-8' },
    { LANG: 'ja_JP.UTF-8' },
    { LC_ALL: 'de_DE.UTF-8', LC_TIME: 'fr_FR.UTF-8' },
    {}
  ])('prints a parseable lstart and intact argv for %o', (locale) => {
    const user = { PATH: process.env.PATH, ...locale }
    const { lstart, command } = read(psLocaleEnvironment(user, 'darwin'))
    expect(lstart).toMatch(US_LSTART)
    expect(Number.isFinite(Date.parse(lstart))).toBe(true)
    expect(command).toBe('orca-ł-日本 30')
  })

  it('shows why: the user locale alone breaks one or the other', () => {
    expect(read({ PATH: process.env.PATH, LANG: 'en_NZ.UTF-8' }).lstart).not.toMatch(US_LSTART)
    expect(read({ PATH: process.env.PATH }).command).not.toBe('orca-ł-日本 30')
  })
})
