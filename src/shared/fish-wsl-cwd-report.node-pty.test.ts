// Real fish under a pty: fish fires fish_prompt only with a terminal attached.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fishRequirementViolation, resolveFishBinary } from './fish-binary-requirement'
import { getWslFishInitCommand } from './wsl-login-shell-command'
import { toWindowsWslPath } from './wsl-paths'
import { parseFileUriPath } from '../main/daemon/osc7-file-uri'

const FISH = resolveFishBinary(3)
const FISH_PATH = FISH.available ? FISH.path : ''
const itWithFish = FISH.available ? it : it.skip
const PROMPT_MARK = 'ORCAFISH> '

type Report = { hosted: boolean; folder: string }

// Every OSC 7 the run printed, read the way the daemon reads a WSL pane's (host ignored).
function reports(output: string): Report[] {
  return output
    .split('\x1b]7;')
    .slice(1)
    .map((report) => report.slice(0, report.indexOf('\x07')))
    .map((uri) => ({
      hosted: !uri.startsWith('file:///'),
      folder: parseFileUriPath(uri, { wslDistro: 'Ubuntu' }) ?? 'unparsed'
    }))
}

// Orca's reports and the foreign one carry no host; fish 4 also sends its own, with one.
const hostless = (output: string): string[] =>
  reports(output)
    .filter((report) => !report.hosted)
    .map((report) => report.folder)

const unc = (folder: string): string => toWindowsWslPath(folder, 'Ubuntu')

describe('a WSL bridge fish pane reports its folder', () => {
  let home: string
  let deep: string
  beforeEach(() => {
    home = realpathSync(mkdtempSync(path.join(tmpdir(), 'wsl-fish-cwd-')))
    deep = path.join(home, 'deep er', 'déjà a%b#c')
    mkdirSync(deep, { recursive: true })
    mkdirSync(path.join(home, 'fish'))
    // The user's own prompt and prompt hook stay theirs.
    writeFileSync(
      path.join(home, 'fish', 'config.fish'),
      [
        'set -g fish_greeting ""',
        `function fish_prompt; printf '${PROMPT_MARK}'; end`,
        'function fish_right_prompt; end',
        'function __user_hook --on-event fish_prompt; echo USER_PROMPT_HOOK; end',
        ''
      ].join('\n')
    )
  })
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  it('has the fish this suite needs when CI requires one', () => {
    expect(fishRequirementViolation(FISH)).toBeNull()
  })

  async function runFish(env: Record<string, string>): Promise<string> {
    const nodePty = await import('node-pty')
    // The exact `-C` the bridge launcher passes after the user's config.
    const term = nodePty.spawn(FISH_PATH, ['-l', '-C', getWslFishInitCommand()], {
      name: 'xterm-256color',
      cols: 200,
      rows: 30,
      cwd: home,
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: home,
        TERM: 'xterm-256color',
        LANG: 'en_US.UTF-8',
        LC_ALL: 'en_US.UTF-8',
        XDG_CONFIG_HOME: home,
        XDG_DATA_HOME: path.join(home, 'data'),
        ...env
      }
    })
    let rendered = ''
    let exited = false
    term.onExit(() => {
      exited = true
    })
    term.onData((chunk) => {
      rendered += chunk
      if (chunk.includes('\x1b[0c') || chunk.includes('\x1b[c')) {
        term.write('\x1b[?62;4;6;22c')
      }
      if (chunk.includes('\x1b[6n')) {
        term.write('\x1b[1;1R')
      }
      if (chunk.includes('\x1b]10;?') || chunk.includes('\x1b]11;?')) {
        term.write('\x1b]11;rgb:1e1e/1e1e/1e1e\x1b\\')
      }
    })
    const prompts = (): number => rendered.split(PROMPT_MARK).length - 1
    const command = async (line: string): Promise<void> => {
      const before = prompts()
      term.write(`${line}\r`)
      await vi.waitFor(() => expect(prompts()).toBeGreaterThan(before), { timeout: 10_000 })
    }
    await vi.waitFor(() => expect(prompts()).toBe(1), { timeout: 15_000 })
    await command(`cd ${JSON.stringify(deep)}`)
    await command('cd .')
    // A foreign report (an ssh session that set its own) lands between prompts.
    await command(String.raw`printf '\e]7;file:///elsewhere\a'`)
    term.write('exit\r')
    await vi.waitFor(() => expect(exited).toBe(true), { timeout: 10_000 })
    return rendered
  }

  itWithFish(
    'at every prompt, after the user config, keeping their prompt and hook',
    async () => {
      const output = await runFish({ WSL_DISTRO_NAME: 'Ubuntu' })
      expect(hostless(output)).toEqual([home, deep, deep, '/elsewhere', deep].map(unc))
      // fish 4's own hosted reports name the same folders, so the two never disagree.
      const hosted = reports(output).filter((report) => report.hosted)
      expect(hosted.length > 0).toBe(FISH.majorVersion >= 4)
      for (const report of hosted) {
        expect([unc(home), unc(deep)]).toContain(report.folder)
      }
      expect(output).toContain('USER_PROMPT_HOOK')
    },
    60_000
  )

  itWithFish(
    'only inside WSL',
    async () => {
      expect(hostless(await runFish({}))).toEqual([unc('/elsewhere')])
    },
    60_000
  )
})
