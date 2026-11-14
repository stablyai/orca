import type { PublicKnownRuntimeEnvironment } from '../../../../shared/remote-runtime/host-catalog/runtime-environments'
import type { RuntimeEnvironmentStatus } from '../../../../shared/remote-runtime/host-status/runtime-host-status'
import { defineFixture } from '../../component-fixtures/component-fixture'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '../ui/dropdown-menu'
import { FloatingWorkspaceHostMenu } from './FloatingWorkspaceHostMenu'

function environment(id: string, name: string): PublicKnownRuntimeEnvironment {
  return {
    id,
    name,
    createdAt: 1,
    updatedAt: 1,
    lastUsedAt: null,
    runtimeId: null,
    endpoints: [{ id: `ws-${id}`, kind: 'websocket', label: 'WebSocket', endpoint: 'ws://host' }],
    preferredEndpointId: `ws-${id}`
  }
}

const connected: RuntimeEnvironmentStatus = {
  checkedAt: 1,
  status: null,
  snapshot: {
    environmentId: 'devbox',
    pairingRevision: 1,
    sequence: 1,
    checkedAt: 1,
    status: null,
    verification: 'verified',
    transport: 'ready'
  }
}

export const pairedServers = defineFixture({
  width: 560,
  store: {
    runtimeEnvironments: [environment('devbox', 'Dev box'), environment('gpu', 'GPU build server')],
    runtimeStatusByEnvironmentId: new Map([['devbox', connected]]),
    runtimeDetectedAgentIds: { devbox: ['claude', 'codex'] }
  },
  render: () => (
    <DropdownMenu modal={false} defaultOpen>
      <DropdownMenuTrigger>New tab</DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        <DropdownMenuItem>New Terminal</DropdownMenuItem>
        <FloatingWorkspaceHostMenu onNewTerminal={() => {}} onLaunchAgent={() => {}} />
      </DropdownMenuContent>
    </DropdownMenu>
  ),
  interact: () => {
    const trigger = document.querySelector<HTMLElement>('[data-slot="dropdown-menu-sub-trigger"]')
    trigger?.focus()
    trigger?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
  }
})
