import { defineFixture } from '../../component-fixtures/component-fixture'
import { MobilePairedDevicesSection } from './mobile/pairing/MobilePairedDevicesSection'
import { RuntimeAccessGrantList } from './runtime-environments/pairing/RuntimeAccessGrantList'

const day = Date.UTC(2026, 10, 1)

export const pairedPhones = defineFixture({
  width: 480,
  render: () => (
    <MobilePairedDevicesSection
      hasQrCode={false}
      onRevokeDevice={() => {}}
      devices={[
        { deviceId: 'a', name: 'Pixel 9', pairedAt: day, lastSeenAt: day },
        {
          deviceId: 'b',
          name: 'iPhone 15',
          pairedAt: day,
          lastSeenAt: day,
          usesLegacyEncryption: true
        }
      ]}
    />
  )
})

export const accessLinks = defineFixture({
  width: 480,
  render: () => (
    <RuntimeAccessGrantList
      currentGrantId={null}
      isLoading={false}
      revokingGrantId={null}
      onRevoke={() => {}}
      grants={[
        { deviceId: 'l1', name: 'Work laptop', createdAt: day, lastSeenAt: day },
        {
          deviceId: 'l2',
          name: 'Build server CLI',
          createdAt: day,
          lastSeenAt: day,
          usesLegacyEncryption: true
        }
      ]}
    />
  )
})
