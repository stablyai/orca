/**
 * The Docker machine provider plugin (tests/e2e/fixtures/docker-machine-provider): every machine
 * is a Docker SSH host container. The app gets its config through launch env, so a spec calls
 * `dockerMachineProviderEnv()` in `test.use` and `prepareDockerMachineProvider()` in its body.
 */
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, type Page } from '@stablyai/playwright-test'
import type {
  MachineProviderKey,
  MachineProviderSnapshot
} from '../../../src/shared/machine-inventory'
import { ensureDockerSshHostImage, getDockerSshHostImage } from './docker-ssh-host-image'

const RUN_ID = `${process.pid}-${Date.now()}`
const KEY_DIR = path.join(os.tmpdir(), `orca-e2e-machines-${RUN_ID}`)
const IDENTITY_FILE = path.join(KEY_DIR, 'id_ed25519')

export const DOCKER_MACHINE_PROVIDER_KEY: MachineProviderKey =
  'plugin:orca-e2e.docker-machines/docker-machines'
export const DOCKER_MACHINE_LABEL = 'orca.e2e.machine'

/** Launch env the provider reads; the identity is created by `prepareDockerMachineProvider`. */
export function dockerMachineProviderEnv(): Record<string, string> {
  return {
    ORCA_E2E_MACHINE_IMAGE: getDockerSshHostImage(),
    ORCA_E2E_MACHINE_RUN_ID: RUN_ID,
    ORCA_E2E_MACHINE_IDENTITY_FILE: IDENTITY_FILE,
    // The app's isolated HOME must still reach the engine that runs the fixture containers.
    DOCKER_CONFIG: process.env.DOCKER_CONFIG ?? path.join(os.homedir(), '.docker'),
    ORCA_E2E_MACHINE_DOCKER_HOME: os.homedir()
  }
}

export type DockerMachineProvider = {
  /** A private copy, so the plugin content hash is the same every run. */
  pluginDir: string
  /** Container ids this run created, by machine id. */
  containerFor: (machineId: string) => string | null
  cleanup: () => void
}

/**
 * For a remote engine (DOCKER_HOST=ssh://…) whose firewall only admits SSH: with
 * ORCA_E2E_MACHINE_PORT_RANGE and ORCA_E2E_MACHINE_TUNNEL_HOST set, forwards each port in the range
 * from this computer's loopback to the engine host's, so machines are reachable at 127.0.0.1.
 */
function openPortRangeTunnel(): ChildProcess | null {
  const tunnelHost = process.env.ORCA_E2E_MACHINE_TUNNEL_HOST?.trim()
  const range = process.env.ORCA_E2E_MACHINE_PORT_RANGE?.match(/^(\d+)-(\d+)$/)
  if (!tunnelHost || !range) {
    return null
  }
  const forwards: string[] = []
  for (let port = Number(range[1]); port <= Number(range[2]); port++) {
    forwards.push('-L', `127.0.0.1:${port}:127.0.0.1:${port}`)
  }
  return spawn(
    'ssh',
    ['-N', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', ...forwards, tunnelHost],
    { stdio: 'ignore' }
  )
}

export function prepareDockerMachineProvider(root = process.cwd()): DockerMachineProvider {
  ensureDockerSshHostImage(root)
  const tunnel = openPortRangeTunnel()
  mkdirSync(KEY_DIR, { recursive: true })
  if (!existsSync(IDENTITY_FILE)) {
    execFileSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-f', IDENTITY_FILE, '-q'])
  }
  const pluginParent = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-machine-plugin-'))
  const pluginDir = path.join(pluginParent, 'docker-machines')
  cpSync(path.join(root, 'tests', 'e2e', 'fixtures', 'docker-machine-provider'), pluginDir, {
    recursive: true
  })
  const runContainers = (): string[] =>
    execFileSync(
      'docker',
      ['ps', '-aq', '--filter', `label=${DOCKER_MACHINE_LABEL}.run=${RUN_ID}`],
      { encoding: 'utf8' }
    )
      .split('\n')
      .filter(Boolean)
  return {
    pluginDir,
    containerFor: (machineId) => {
      const id = execFileSync(
        'docker',
        ['ps', '-aq', '--filter', `label=${DOCKER_MACHINE_LABEL}.id=${machineId}`],
        { encoding: 'utf8' }
      ).trim()
      return id || null
    },
    cleanup: () => {
      tunnel?.kill()
      const ids = runContainers()
      if (ids.length > 0) {
        spawnSync('docker', ['rm', '-f', ...ids], { stdio: 'ignore', timeout: 30_000 })
      }
      rmSync(pluginParent, { recursive: true, force: true })
      rmSync(KEY_DIR, { recursive: true, force: true })
    }
  }
}

export function isDockerMachineRunning(containerId: string): boolean {
  return (
    execFileSync('docker', ['inspect', '--format', '{{.State.Running}}', containerId], {
      encoding: 'utf8'
    }).trim() === 'true'
  )
}

/**
 * Turns on plugins and Machines, installs the provider, and enables it through the consent dialog,
 * which must show the provider's exact argv.
 */
export async function installDockerMachineProvider(page: Page, pluginDir: string): Promise<void> {
  const pluginKey = await page.evaluate(async (sourcePath) => {
    const settings = await window.api.settings.set({
      pluginSystemEnabled: true,
      experimentalEphemeralVms: true
    })
    window.__store?.setState({ settings })
    const result = await window.api.plugins.install({ kind: 'local-path', path: sourcePath })
    if (!result.ok) {
      throw new Error(result.error)
    }
    await window.api.plugins.refresh()
    return result.pluginKey
  }, pluginDir)

  await page.evaluate(() => {
    const state = window.__store?.getState()
    state?.openSettingsTarget({ pane: 'plugins', repoId: null })
    state?.openSettingsPage()
  })
  await page.getByRole('tab', { name: /^Installed/ }).click()
  const row = page.locator(`[data-plugin-key="${pluginKey}"]`)
  await row.getByRole('button', { name: 'Review & enable' }).click()
  const consent = page.getByRole('dialog', { name: /Review (permissions|plugin content)/ })
  await expect(consent.getByLabel('Docker machines · machine provider command')).toHaveText(
    '"$orca-node" "$plugin/bin/docker-machine-provider.mjs"'
  )
  await consent.getByRole('button', { name: 'Enable plugin' }).click()
  await expect(row).toContainText('Enabled')
  await page.evaluate(() => window.__store?.getState().closeSettingsPage())

  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const result = await window.api.machines.snapshots()
          return result.ok ? result.value.map((snapshot) => snapshot.providerKey) : []
        }),
      { timeout: 15_000, message: 'the machine provider never registered' }
    )
    .toContain(DOCKER_MACHINE_PROVIDER_KEY)
}

export async function machineSnapshot(page: Page): Promise<MachineProviderSnapshot | null> {
  return page.evaluate(async (providerKey) => {
    const result = await window.api.machines.list({ providerKey, force: true })
    return result.ok ? result.value : null
  }, DOCKER_MACHINE_PROVIDER_KEY)
}
