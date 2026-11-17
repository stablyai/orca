import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { AccountMfaRowView } from './AccountMfaRow'
import type { AccountMfaState } from './use-account-mfa'

const width = 760
const noop = (): void => {}
const setupUrl = 'https://cloud.orca.dev/v1/account/security'

/** The row as it sits under the signed-in identity in Settings, Account. */
function row(state: AccountMfaState, frameWidth = width) {
  return defineFixture({
    width: frameWidth,
    render: () => (
      <div className="bg-background px-8 py-6">
        <AccountMfaRowView state={state} onOpenSetup={noop} />
      </div>
    )
  })
}

/** No second factor yet: why to add one, and Set up in browser (chevron: Copy link). */
export const off = row({ kind: 'known', mfa: 'off', setupUrl })

/** Enrolled: Manage in browser, for a new authenticator or the backup codes. */
export const on = row({ kind: 'known', mfa: 'on', setupUrl })

/** A narrow settings pane: the button wraps under the text. */
export const offNarrow = row({ kind: 'known', mfa: 'off', setupUrl }, 420)

/** The chevron's menu, open on Copy link. */
export const copyLinkMenu = defineFixture({
  width,
  render: () => (
    <div className="bg-background px-8 pt-6 pb-24">
      <AccountMfaRowView state={{ kind: 'known', mfa: 'off', setupUrl }} onOpenSetup={noop} />
    </div>
  ),
  interact: async (frame) => {
    const chevron = frame.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')
    chevron?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
})
