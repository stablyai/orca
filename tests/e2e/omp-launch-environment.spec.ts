import { chmod, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, delimiter, join } from 'node:path'
import { test as base, expect } from './helpers/orca-app'
import { buildShellCommandFromArgv } from '../../src/shared/tui-agent-startup-shell'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  execInTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager
} from './helpers/terminal'

const test = base.extend({
  launchEnv: async ({ seedTestRepo }, run, testInfo) => {
    void seedTestRepo
    if (!process.env.ORCA_OMP_PROOF_BINARY || process.platform !== 'darwin') {
      await run({})
      return
    }
    const shell = testInfo.outputPath('login-shell')
    const profileDir = testInfo.outputPath('profile')
    await mkdir(profileDir, { recursive: true })
    await writeFile(
      join(profileDir, '.zprofile'),
      `
export PI_CONFIG_DIR="\${PI_CONFIG_DIR:-.omp-profile-proof}"
export XDG_DATA_HOME="\${XDG_DATA_HOME:-$HOME/xdg-data}"
export XDG_STATE_HOME="\${XDG_STATE_HOME:-$HOME/xdg-state}"
export XDG_CACHE_HOME="\${XDG_CACHE_HOME:-$HOME/xdg-cache}"
mkdir -p "$HOME/$PI_CONFIG_DIR/agent" "$XDG_DATA_HOME/omp" "$XDG_STATE_HOME/omp" "$XDG_CACHE_HOME/omp"
`
    )
    await writeFile(
      shell,
      `#!/bin/sh
case "$ORCA_E2E_HOME_DIR" in
  */orca-e2e-userdata-*/home) ;;
  *) echo 'Refusing profile proof outside isolated E2E home' >&2; exit 73 ;;
esac
export HOME="$ORCA_E2E_HOME_DIR"
export ZDOTDIR=${buildShellCommandFromArgv([profileDir], 'posix')}
exec /bin/zsh "$@"
`
    )
    await chmod(shell, 0o700)
    await run({
      PATH: [dirname(process.env.ORCA_OMP_PROOF_BINARY ?? '/usr/bin/omp'), process.env.PATH]
        .filter(Boolean)
        .join(delimiter),
      SHELL: shell,
      XDG_DATA_HOME: undefined,
      XDG_STATE_HOME: undefined,
      XDG_CACHE_HOME: undefined,
      XDG_CONFIG_HOME: undefined,
      PI_CONFIG_DIR: undefined
    })
  }
})

test('OMP launched by Orca uses login-profile data and config roots', async ({
  orcaPage,
  electronApp
}, testInfo) => {
  test.skip(
    !process.env.ORCA_OMP_PROOF_BINARY || process.platform !== 'darwin',
    'Opt-in macOS OMP runtime proof'
  )
  await waitForSessionReady(orcaPage)
  const worktreeId = await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage)
  const ptyId = await waitForActivePanePtyId(orcaPage)
  const home = await electronApp.evaluate(({ app }) => app.getPath('home'))
  expect(await electronApp.evaluate(() => process.env.XDG_DATA_HOME)).toBeUndefined()
  const result = testInfo.outputPath('omp-paths.json')
  const probe = testInfo.outputPath('path-probe.ts')
  await writeFile(
    probe,
    `import { writeFileSync } from 'node:fs'
export default function (api) {
 api.on('session_start', (_event, ctx) => {
  writeFileSync(process.env.ORCA_PATH_PROBE_OUTPUT || ${JSON.stringify(result)}, JSON.stringify({
   data: process.env.XDG_DATA_HOME, config: process.env.PI_CONFIG_DIR,
   source: process.env.ORCA_OMP_SOURCE_AGENT_DIR,
   status: process.env.ORCA_OMP_STATUS_EXTENSION,
   session: ctx.sessionManager.getSessionFile(), pid: process.pid
  }))
 })
}`
  )
  await execInTerminal(
    orcaPage,
    ptyId,
    buildShellCommandFromArgv(['omp', '--no-extensions', '--extension', probe], 'posix')
  )
  await expect
    .poll(
      async () => {
        try {
          return JSON.parse(await readFile(result, 'utf8'))
        } catch {
          return null
        }
      },
      { timeout: 45_000 }
    )
    .toEqual(
      expect.objectContaining({
        data: join(home, 'xdg-data'),
        config: '.omp-profile-proof',
        source: join(home, '.omp-profile-proof', 'agent'),
        status: expect.stringContaining(join('.omp-profile-proof', 'agent', 'extensions')),
        session: expect.stringContaining(join('xdg-data', 'omp', 'sessions'))
      })
    )
  await expect(orcaPage.locator('.xterm-screen').first()).toBeVisible()
  await orcaPage.screenshot({ path: testInfo.outputPath('omp-profile-root.png') })
  expect(await readdir(join(home, 'xdg-data', 'omp'))).toContain('agent.db')
  const overrideData = join(home, 'pane-data')
  await mkdir(join(overrideData, 'omp'), { recursive: true })
  const overrideResult = testInfo.outputPath('omp-pane-paths.json')
  const overridePty = await orcaPage.evaluate(
    async ({ command, worktreeId, home, overrideData, overrideResult }) => {
      const pane = await window.api.pty.spawn({
        cols: 100,
        rows: 30,
        cwd: home,
        worktreeId,
        initiallyHidden: true,
        launchAgent: 'omp',
        command,
        env: {
          XDG_DATA_HOME: overrideData,
          PI_CONFIG_DIR: '.omp-pane-config',
          ORCA_PATH_PROBE_OUTPUT: overrideResult
        }
      })
      return pane.id
    },
    {
      command: buildShellCommandFromArgv(['omp', '--no-extensions', '--extension', probe], 'posix'),
      worktreeId,
      home,
      overrideData,
      overrideResult
    }
  )
  try {
    await expect
      .poll(
        async () => {
          try {
            return JSON.parse(await readFile(overrideResult, 'utf8'))
          } catch {
            return null
          }
        },
        { timeout: 45_000 }
      )
      .toEqual(
        expect.objectContaining({
          data: overrideData,
          config: '.omp-pane-config',
          source: join(home, '.omp-pane-config', 'agent'),
          session: expect.stringContaining(join('pane-data', 'omp', 'sessions'))
        })
      )
    expect(await readdir(join(overrideData, 'omp'))).toContain('agent.db')
  } finally {
    await orcaPage.evaluate((id) => window.api.pty.kill(id), overridePty)
  }
  const baselineResult = testInfo.outputPath('omp-login-baseline.json')
  const baselineCommand = buildShellCommandFromArgv(
    [
      'env',
      ...[
        'XDG_DATA_HOME',
        'XDG_STATE_HOME',
        'XDG_CACHE_HOME',
        'PI_CONFIG_DIR',
        'ORCA_OMP_SOURCE_AGENT_DIR',
        'ORCA_OMP_STATUS_EXTENSION',
        'ORCA_PI_STATUS_OWNED',
        'ZDOTDIR',
        'ORCA_ORIG_ZDOTDIR'
      ].flatMap((key) => ['-u', key]),
      `ORCA_PATH_PROBE_OUTPUT=${baselineResult}`,
      `HOME=${home}`,
      `ZDOTDIR=${testInfo.outputPath('profile')}`,
      '/bin/zsh',
      '-ilc',
      buildShellCommandFromArgv(
        [process.env.ORCA_OMP_PROOF_BINARY ?? '', '--no-extensions', '--extension', probe],
        'posix'
      )
    ],
    'posix'
  )
  const baselinePty = await orcaPage.evaluate(
    async ({ command, worktreeId, home }) => {
      return (
        await window.api.pty.spawn({
          cols: 100,
          rows: 30,
          cwd: home,
          worktreeId,
          initiallyHidden: true,
          command
        })
      ).id
    },
    { command: baselineCommand, worktreeId, home }
  )
  try {
    await expect
      .poll(
        async () => {
          try {
            return JSON.parse(await readFile(baselineResult, 'utf8'))
          } catch {
            return null
          }
        },
        { timeout: 45_000 }
      )
      .toEqual(
        expect.objectContaining({
          data: join(home, 'xdg-data'),
          config: '.omp-profile-proof',
          session: expect.stringContaining(join('xdg-data', 'omp', 'sessions'))
        })
      )
  } finally {
    await orcaPage.evaluate((id) => window.api.pty.kill(id), baselinePty)
  }
})
