import { defineFixture } from '../../component-fixtures/component-fixture'
import { VmBuildBillingBlockerView, type BillingBlockKind } from './VmBuildBillingBlocker'

const noop = (): void => {}
const handlers = {
  onComparePlans: noop,
  onOpenBilling: noop,
  onCheckAgain: noop,
  onBackToDraft: noop
}

function blocker(kind: BillingBlockKind, inBrowser = false): React.JSX.Element {
  return (
    <div className="p-4">
      <VmBuildBillingBlockerView
        kind={kind}
        canManageBilling
        phase={
          inBrowser
            ? { kind: 'browser', checking: false, stillBlocked: false, via: 'console' }
            : { kind: 'idle' }
        }
        {...handlers}
      />
    </div>
  )
}

/** Out of hours, for an owner: overage is turned on in the web console. */
export const hoursUsed = defineFixture({ width: 520, render: () => blocker('hoursUsed') })
export const spendCap = defineFixture({ width: 520, render: () => blocker('spendCap') })
export const payment = defineFixture({ width: 520, render: () => blocker('payment') })
/** Back from the browser: Orca re-checks on focus, or with Check again. */
export const finishInBrowser = defineFixture({
  width: 520,
  render: () => blocker('hoursUsed', true)
})
