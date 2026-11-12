import type { PublicKnownRuntimeEnvironment } from '../../../../../../shared/remote-runtime/host-catalog/runtime-environments'
import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { SettingsHostScopePicker } from '../../host-scope/SettingsHostScopePicker'
import type { SettingsHostScope } from '../../host-scope/settings-host-scope'
import { RuntimeDefaultHostRow } from './runtime-default-host-row'

function environment(index: number): PublicKnownRuntimeEnvironment {
  const id = `server-${index}`
  return {
    id,
    name: `${['Boston', 'Berlin', 'Dublin', 'London', 'Montreal', 'Oslo'][index % 6]} build server ${index}`,
    createdAt: index,
    updatedAt: index,
    lastUsedAt: null,
    runtimeId: null,
    endpoints: [
      {
        id: `ws-${index}`,
        kind: 'websocket',
        label: 'WebSocket',
        endpoint: 'ws://localhost:6768'
      }
    ],
    preferredEndpointId: `ws-${index}`
  }
}

const environments = Array.from({ length: 12 }, (_, index) => environment(index + 1))
const selectedHostId = 'server-8'
const scope: SettingsHostScope = {
  target: { kind: 'environment', environmentId: selectedHostId },
  available: true
}

const fixture = {
  width: 800,
  store: { runtimeEnvironments: environments },
  interact: (frame: HTMLElement) => {
    frame.querySelector<HTMLButtonElement>('button[role="combobox"]')?.click()
  }
}

export const runtimeDefaultHostMenu = defineFixture({
  ...fixture,
  render: () => (
    <RuntimeDefaultHostRow
      allowLocalRuntime
      activeValue={selectedHostId}
      environments={environments}
      isBusy={false}
      onValueChange={() => {}}
    />
  )
})

export const settingsHostScopeMenu = defineFixture({
  ...fixture,
  render: () => (
    <SettingsHostScopePicker scope={scope} environments={environments} onChoose={() => {}} />
  )
})
