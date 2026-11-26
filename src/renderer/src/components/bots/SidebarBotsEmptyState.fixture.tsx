import { defineFixture } from '../../component-fixtures/component-fixture'
import { SidebarBotsEmptyState } from './SidebarBotsEmptyState'

// Widths are the sidebar's minimum and a wide drag; zoom stands in for a larger UI text size.
function Card({ width, zoom = 1 }: { width: number; zoom?: number }) {
  return (
    <div className="bg-sidebar py-2" style={{ width }}>
      <div style={{ zoom, width: width / zoom }}>
        <SidebarBotsEmptyState onNewBot={() => {}} />
      </div>
    </div>
  )
}

export const empty = defineFixture({ render: () => <Card width={260} /> })
export const narrow = defineFixture({ render: () => <Card width={220} /> })
export const wide = defineFixture({ render: () => <Card width={460} /> })
export const narrowLargeText = defineFixture({ render: () => <Card width={220} zoom={1.4} /> })
export const wideLargeText = defineFixture({ render: () => <Card width={460} zoom={1.4} /> })
