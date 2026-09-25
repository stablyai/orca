import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { runProcess } from '../../src/shared/child-process/run-process'
import { inheritOmpLaunchEnvironment } from '../../src/main/ipc/pty/host-env/omp-launch-environment'
import { resetLoginShellEnvironmentCacheForTests } from '../../src/main/startup/login-shell-environment'
import { PiTitlebarExtensionService } from '../../src/main/pi/titlebar-extension-service'
const fixture = { home: '', shell: '' }
const shells = ['bash', 'zsh', 'fish'].map((name) => {
  const path = (process.env.PATH ?? '')
    .split(delimiter)
    .map((dir) => join(dir, name))
    .find(existsSync)
  return { name, path }
})
afterEach(() => {
  vi.unstubAllEnvs()
  resetLoginShellEnvironmentCacheForTests()
  if (fixture.home) {
    rmSync(fixture.home, { recursive: true, force: true })
  }
})
function prepare(shell) {
  fixture.home = mkdtempSync(join(tmpdir(), 'omp20605-shell-root-'))
  fixture.shell = shell.path
  vi.stubEnv('HOME', fixture.home)
  vi.stubEnv('SHELL', shell.path)
  vi.stubEnv('ZDOTDIR', fixture.home)
  vi.stubEnv('XDG_CONFIG_HOME', join(fixture.home, '.config'))
  vi.stubEnv('PI_CONFIG_DIR', undefined)
  const file =
    shell.name === 'fish'
      ? '.config/fish/config.fish'
      : shell.name === 'zsh'
        ? '.zprofile'
        : '.bash_profile'
  mkdirSync(join(fixture.home, '.config/fish'), { recursive: true })
  writeFileSync(
    join(fixture.home, file),
    shell.name === 'fish'
      ? 'if not set -q PI_CONFIG_DIR; or test -z "$PI_CONFIG_DIR"\n set -gx PI_CONFIG_DIR .profile-omp\nend\n'
      : 'export PI_CONFIG_DIR="${PI_CONFIG_DIR:-.profile-omp}"\n'
  )
}
for (const shell of shells) {
  for (const config of [undefined, '.pane-omp', '']) {
    it.skipIf(process.platform === 'win32' || !shell.path)(
      `${shell.name}: local installer agrees with the launched shell, pane=${JSON.stringify(config)}`,
      async () => {
        prepare(shell)
        const env = config === undefined ? {} : { PI_CONFIG_DIR: config }
        await inheritOmpLaunchEnvironment(env, { launchAgent: 'omp', explicitEnv: { ...env } })
        const service = new PiTitlebarExtensionService()
        const managed = service.buildPtyEnv('root-proof', undefined, 'omp', {
          configDirName: env.PI_CONFIG_DIR
        })
        const result = await runProcess({
          program: shell.path,
          args: ['-ilc', 'printf "ROOT=%s\\n" "$PI_CONFIG_DIR"'],
          env: { ...process.env, ...env }
        })
        expect(result.code).toBe(0)
        const actual = result.stdout.match(/ROOT=([^\r\n]*)/)?.[1]
        if (config === '') {
          expect(actual).toBe('.omp')
        }
        expect(managed.ORCA_OMP_SOURCE_AGENT_DIR).toBe(
          join(fixture.home, actual || '.omp', 'agent')
        )
      }
    )
  }
}

const selectedShell = shells.find((shell) => shell.name === 'zsh')
it.skipIf(process.platform === 'win32' || !selectedShell?.path).each(['provider', 'daemon'])(
  '%s uses the selected pane shell instead of the process default',
  async (route) => {
    prepare(selectedShell)
    vi.stubEnv('SHELL', '/bin/bash')
    writeFileSync(join(fixture.home, '.bash_profile'), 'export PI_CONFIG_DIR=.wrong-shell\n')
    const env = { SHELL: route === 'provider' ? '/bin/bash' : selectedShell.path }
    await inheritOmpLaunchEnvironment(env, {
      launchAgent: 'omp',
      explicitEnv: { ...env },
      ...(route === 'provider' ? { shellPath: selectedShell.path } : {})
    })
    expect(env.PI_CONFIG_DIR).toBe('.profile-omp')
    const launched = await runProcess({
      program: selectedShell.path,
      args: ['-ilc', 'printf "ROOT=%s\\n" "$PI_CONFIG_DIR"'],
      env: { ...process.env, ...env }
    })
    expect(launched.code).toBe(0)
    expect(launched.stdout).toContain('ROOT=.profile-omp')
  }
)
