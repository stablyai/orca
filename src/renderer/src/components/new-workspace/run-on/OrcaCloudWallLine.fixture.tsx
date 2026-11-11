import { defineFixture } from '../../../component-fixtures/component-fixture'
import { OrcaCloudWallLine } from './OrcaCloudWallLine'

// The Run on column is half the composer: about 230px. The reason wraps, never truncates.
function Column({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="w-[230px] p-2">{children}</div>
}

export const ownerOutOfHours = defineFixture({
  width: 260,
  render: () => (
    <Column>
      <OrcaCloudWallLine
        wall={{
          reason: 'Out of sandbox hours',
          action: { label: 'Turn on overage', run: () => {} }
        }}
      />
    </Column>
  )
})
export const ownerPaymentFailed = defineFixture({
  width: 260,
  render: () => (
    <Column>
      <OrcaCloudWallLine
        wall={{
          reason: 'Payment failed',
          action: { label: 'Update payment method', run: () => {} }
        }}
      />
    </Column>
  )
})
export const memberPlanEnded = defineFixture({
  width: 260,
  render: () => (
    <Column>
      <OrcaCloudWallLine wall={{ reason: 'Your Team plan ended', action: null }} />
    </Column>
  )
})
