import { expect, it } from 'vitest'
import { botCreateHosts } from './bot-create-hosts'
import type { WslHostStatus } from '../../../../shared/remote-runtime/wsl-hosts/wsl-host-types'

const environment = (id: string) =>
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: botCreateHosts reads only id, name and orcadDeployment here
  ({
    id,
    name: `${id} (WSL)`,
    endpoints: [],
    preferredEndpointId: null,
    orcadDeployment: { kind: 'wsl', distro: id }
  }) as never

const status = (environmentId: string, state: WslHostStatus['state']): WslHostStatus => ({
  environmentId,
  distro: environmentId,
  state,
  detail: null
})

it('maps unreachable WSL hosts to sleeping, waking or offline', () => {
  const hosts = botCreateHosts({
    runtimeEnvironments: [environment('idle'), environment('waking'), environment('stopped')],
    runtimeStatusByEnvironmentId: new Map(),
    sshTargetLabels: new Map(),
    wslHostStatuses: {
      idle: status('idle', 'idle'),
      waking: status('waking', 'connecting'),
      stopped: status('stopped', 'distro-stopped')
    },
    waking: new Set(['waking'])
  })
  const byId = Object.fromEntries(hosts.map((host) => [host.environmentId, host]))
  expect(byId.idle).toMatchObject({ sleeping: true })
  expect(byId.idle.blocked).toBeUndefined()
  expect(byId.waking).toMatchObject({ waking: true })
  expect(byId.waking.blocked).toBeUndefined()
  expect(byId.stopped).toMatchObject({ blocked: 'offline' })
  expect(byId.stopped.sleeping).toBeUndefined()
})
