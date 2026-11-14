import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { AccountTeamAdminRowView } from './AccountTeamAdminRow'

const noop = (): void => {}

/** The row as it sits under the identity in Settings, Account: one way into the web console. */
function row(frameWidth: number, busy = false) {
  return defineFixture({
    width: frameWidth,
    render: () => (
      <div className="bg-background px-8 py-6">
        <AccountTeamAdminRowView busy={busy} onOpen={noop} />
      </div>
    )
  })
}

export const idle = row(760)

/** A narrow settings pane: the button wraps under the text. */
export const narrow = row(420)

/** Asking auth for the single-use code: the button holds still and ignores a second press. */
export const opening = row(760, true)
