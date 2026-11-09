import { defineFixture } from '../../../../component-fixtures/component-fixture'
import type { HostHeaderRow } from '../../../../../../shared/sidebar-list/host-section-rows'
import { HostSectionHeader } from './HostSectionHeader'

const base: HostHeaderRow = {
  type: 'host-header',
  key: 'host:runtime:vm',
  hostId: 'runtime:vm',
  kind: 'runtime',
  label: 'feature-login VM',
  detail: 'Orca server',
  health: 'available',
  collapsed: false,
  count: 1
}

const rows: HostHeaderRow[] = [
  base,
  { ...base, key: 'p', health: 'provisioning', vmState: 'provisioning' },
  { ...base, key: 's', health: 'suspended', vmState: 'suspended' },
  { ...base, key: 'w', health: 'waking', vmState: 'waking' },
  { ...base, key: 'f', health: 'error', vmState: 'resume_failed' },
  { ...base, key: 'x', health: 'error', vmState: 'provision_failed' },
  { ...base, key: 'd', health: 'disconnected' }
]

export const vmLifecycle = defineFixture({
  width: 300,
  render: () => (
    <div className="flex flex-col gap-1 bg-sidebar py-2">
      {rows.map((row) => (
        <HostSectionHeader key={row.key} row={row} onToggle={() => undefined} />
      ))}
    </div>
  )
})
