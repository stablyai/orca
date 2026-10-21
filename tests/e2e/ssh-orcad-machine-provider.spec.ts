/**
 * A machine provider plugin end to end against real Docker SSH hosts: consent shows its argv, then
 * create, connect with provider-pinned host keys, sleep, wake on a remapped port, and delete,
 * through the machines API. ssh-orcad-machine-ui-journey.spec.ts drives the same fixture by UI.
 */
import { randomUUID } from 'node:crypto'
import type { MachineActionResult, MachineRecord } from '../../src/shared/machine-inventory'
import { expect, test } from './helpers/orca-app'
import {
  DOCKER_MACHINE_PROVIDER_KEY,
  dockerMachineProviderEnv,
  installDockerMachineProvider,
  isDockerMachineRunning,
  machineSnapshot,
  prepareDockerMachineProvider,
  type DockerMachineProvider
} from './helpers/docker-machine-provider'
import { ORCAD_TEMPLATE, skipUnlessManagedDockerHost } from './helpers/orcad-managed-workspace'
import { waitForSessionReady } from './helpers/store'

// Machines are served by a managed Orca server; a plain relay refuses them.
skipUnlessManagedDockerHost()
test.skip(process.platform === 'win32', 'The fixture provider drives the Docker CLI on POSIX hosts')
test.use({
  seedTestRepo: false,
  orcaAppExtraEnv: { ORCA_ORCAD_TEMPLATE_PATH: ORCAD_TEMPLATE ?? '', ...dockerMachineProviderEnv() }
})

test('runs a provider machine through create, connect, sleep, wake and delete', async ({
  orcaPage
}) => {
  // The first connect deploys the machine's managed server.
  test.setTimeout(420_000)
  let provider: DockerMachineProvider | null = null
  try {
    provider = prepareDockerMachineProvider()
    await waitForSessionReady(orcaPage)
    await installDockerMachineProvider(orcaPage, provider.pluginDir)

    const operationId = randomUUID()
    const created = await orcaPage.evaluate(
      async ({ providerKey, operationId }) => {
        const chunks: string[] = []
        const stop = window.api.machines.onProgress((event) => {
          if (event.operationId === operationId) {
            chunks.push(event.chunk)
          }
        })
        try {
          const result = await window.api.machines.create({
            providerKey,
            operationId,
            name: 'e2e-machine',
            lifetime: 'temporary',
            ttlSeconds: 3600
          })
          return { result, progress: chunks.join('') }
        } finally {
          stop()
        }
      },
      { providerKey: DOCKER_MACHINE_PROVIDER_KEY, operationId }
    )
    const machine = unwrap(created.result)
    expect(machine).toMatchObject({ state: 'running', lifetime: 'temporary' })
    expect(created.progress).toContain('starting docker machine')
    const container = provider.containerFor(machine.id)
    expect(container).not.toBeNull()

    const target = { providerKey: DOCKER_MACHINE_PROVIDER_KEY, machineId: machine.id }
    const connect = async () =>
      unwrap(await orcaPage.evaluate((args) => window.api.machines.connect(args), target))
    // Only the key the provider read from the container is accepted.
    expect(await connect()).toMatchObject({ kind: 'ssh' })

    const slept = unwrap(await orcaPage.evaluate((args) => window.api.machines.sleep(args), target))
    expect(slept.state).toBe('sleeping')
    expect(isDockerMachineRunning(container!)).toBe(false)

    const woken = unwrap(await orcaPage.evaluate((args) => window.api.machines.wake(args), target))
    expect(woken.state).toBe('running')
    // Docker remaps the port on start, so this connect moves the same target to a new endpoint.
    // A fixed port range (a remote engine behind a firewall) keeps the port across wake.
    if (!process.env.ORCA_E2E_MACHINE_PORT_RANGE) {
      expect(sshPort(woken)).not.toBe(sshPort(machine))
    }
    expect(await connect()).toMatchObject({ kind: 'ssh' })

    const deleted = unwrap(
      await orcaPage.evaluate((args) => window.api.machines.delete(args), target)
    )
    expect(deleted.state).toBe('gone')
    expect(provider.containerFor(machine.id)).toBeNull()
    // Its managed server is still saved, so the row stays as its worktrees' Gone link.
    expect((await machineSnapshot(orcaPage))?.machines).toEqual([
      expect.objectContaining({
        id: machine.id,
        state: 'gone',
        managedEnvironmentId: expect.any(String)
      })
    ])
    // That server is retired: kept for the link, never dialed again.
    const gone = (await machineSnapshot(orcaPage))?.machines[0]
    const environments = await orcaPage.evaluate(() => window.api.runtimeEnvironments.list())
    expect(
      environments.find((environment) => environment.id === gone?.managedEnvironmentId)
    ).toMatchObject({ retiredAt: expect.any(String) })
  } finally {
    provider?.cleanup()
  }
})

function unwrap<T>(result: MachineActionResult<T>): T {
  if (!result.ok) {
    throw new Error(`${result.code}: ${result.message}`)
  }
  return result.value
}

function sshPort(record: MachineRecord): number | null {
  return record.access?.kind === 'ssh' ? record.access.port : null
}
