import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { runProcess } from '../../src/shared/child-process/run-process'
import { resetLoginShellEnvironmentCacheForTests } from '../../src/main/startup/login-shell-environment'
import { PluginOverlayManager } from '../../src/relay/plugin-overlay'
import { resolveOmpConfigDirName } from '../../src/relay/plugin-overlay-env'
import { __resetShellStartupEnvCache } from '../../src/main/pty/shell-startup-env'
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
  __resetShellStartupEnvCache()
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
  for (const config of [undefined, '', '.pane-omp']) {
    it.skipIf(process.platform === 'win32' || !shell.path)(
      `${shell.name}: relay root matches profile execution, pane=${JSON.stringify(config)}`,
      async () => {
        prepare(shell)
        const env = { HOME: fixture.home, XDG_CONFIG_HOME: join(fixture.home, '.config') }
        if (config !== undefined) {
          env.PI_CONFIG_DIR = config
        }
        const configDirName = await resolveOmpConfigDirName(env, shell.path)
        if (configDirName !== undefined) {
          env.PI_CONFIG_DIR = configDirName
        }
        const manager = new PluginOverlayManager({ homeDir: fixture.home })
        manager.setSources({ ompExtensionSource: 'export default function() {}' })
        const installed = manager.materializePi('pane', undefined, 'omp', { configDirName })
        const result = await runProcess({
          program: shell.path,
          args: ['-ilc', 'printf "ROOT=%s\\n" "$PI_CONFIG_DIR"'],
          env
        })
        expect(result.code).toBe(0)
        const actual = result.stdout.match(/ROOT=([^\r\n]*)/)?.[1]
        expect(actual).toBe(config === undefined ? '.profile-omp' : config || '.omp')
        expect(installed?.sourceAgentDir).toBe(join(fixture.home, actual || '.omp', 'agent'))
      }
    )
  }
}
