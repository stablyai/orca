import { defineFixture } from '../component-fixtures/component-fixture'
import { LandingActions } from './landing-layout'

const noop = (): void => {}

function row(width: number): React.JSX.Element {
  return (
    <div className="bg-background p-4">
      <div className="@container w-full px-6" style={{ width }}>
        <LandingActions
          overCloudList
          addProjectLabel="Add project"
          createLabel="Create workspace"
          onAddProject={noop}
          onCreate={noop}
        />
        <div className="mt-4 h-24 rounded-xl border border-border bg-card" />
      </div>
    </div>
  )
}

/** JA-30: over the cloud list in a wide centre column, the full-size top row. */
export const actionsOverCloudListWide = defineFixture({ width: 800, render: () => row(768) })

/** JA-30: a narrow centre column (both side panels open): small buttons, still one row. */
export const actionsOverCloudListNarrow = defineFixture({ width: 580, render: () => row(540) })
