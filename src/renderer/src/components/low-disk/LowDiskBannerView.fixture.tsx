import { defineFixture } from '../../component-fixtures/component-fixture'
import { LowDiskBannerView } from './LowDiskBannerView'

const GIB = 1024 ** 3
const MIB = 1024 ** 2

export const warning = defineFixture({
  width: 900,
  render: () => (
    <LowDiskBannerView
      level="warning"
      availableBytes={1.4 * GIB}
      totalBytes={32 * GIB}
      onDismiss={() => {}}
    />
  )
})

export const critical = defineFixture({
  width: 900,
  render: () => (
    <LowDiskBannerView
      level="critical"
      availableBytes={310 * MIB}
      totalBytes={32 * GIB}
      onDismiss={() => {}}
    />
  )
})

export const narrowCritical = defineFixture({
  width: 420,
  render: () => (
    <LowDiskBannerView
      level="critical"
      availableBytes={310 * MIB}
      totalBytes={32 * GIB}
      onDismiss={() => {}}
    />
  )
})
