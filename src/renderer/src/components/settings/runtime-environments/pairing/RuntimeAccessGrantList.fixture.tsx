import {
  defineFixture,
  type ComponentFixture
} from '../../../../component-fixtures/component-fixture'
import type { RuntimeAccessGrant } from '../../../../../../shared/remote-runtime/host-catalog/runtime-access-grants'
import { RuntimeAccessGrantList } from './RuntimeAccessGrantList'

// "Share this computer" body width: sm:max-w-xl (576) minus p-6; the 600px window minimum leaves 520.
const DIALOG_WIDTH = 528
const NARROWEST_WIDTH = 520
const HOUR = 3_600_000
const NEWEST = Date.UTC(2026, 10, 20, 15, 1)

function links(count: number): RuntimeAccessGrant[] {
  return Array.from({ length: count }, (_, index) => {
    const createdAt = NEWEST - index * 61 * HOUR
    return {
      deviceId: `link-${index}`,
      name: `Runtime ${new Date(createdAt).toISOString()}`,
      createdAt,
      lastSeenAt: index % 4 === 3 ? null : createdAt + 3 * HOUR
    }
  })
}

function listFixture(
  count: number,
  width: number,
  interact?: ComponentFixture['interact']
): ComponentFixture {
  return defineFixture({
    width,
    interact,
    render: () => (
      <RuntimeAccessGrantList
        className="border-t border-border/40 pt-3"
        grants={links(count)}
        currentGrantId="link-0"
        isLoading={false}
        revokingGrantId={null}
        onRevoke={() => {}}
      />
    )
  })
}

const scrollList = (to: 'bottom' | 'middle') => (frame: HTMLElement) => {
  const list = frame.querySelector<HTMLElement>('.overflow-y-auto')
  if (list) {
    list.scrollTop = to === 'bottom' ? list.scrollHeight : list.scrollHeight / 2 - 80
  }
}

const focusRevoke = (frame: HTMLElement): void => {
  scrollList('middle')(frame)
  const buttons = frame.querySelectorAll<HTMLButtonElement>('button[aria-label^="Revoke"]')
  // Tabbing scrolls the focused button into view, as the keyboard would.
  buttons[5]?.focus()
}

export const twoLinks = listFixture(2, DIALOG_WIDTH)
export const fourLinksPeek = listFixture(4, DIALOG_WIDTH)
export const twelveLinksTop = listFixture(12, DIALOG_WIDTH)
export const twelveLinksBottom = listFixture(12, DIALOG_WIDTH, scrollList('bottom'))
export const twelveLinksRevokeFocused = listFixture(12, DIALOG_WIDTH, focusRevoke)
export const narrowTwoLinks = listFixture(2, NARROWEST_WIDTH)
export const narrowFourLinksPeek = listFixture(4, NARROWEST_WIDTH)
export const narrowTwelveLinksTop = listFixture(12, NARROWEST_WIDTH)
export const narrowTwelveLinksBottom = listFixture(12, NARROWEST_WIDTH, scrollList('bottom'))
export const narrowTwelveLinksRevokeFocused = listFixture(12, NARROWEST_WIDTH, focusRevoke)

// Notices make rows taller than the 3.5-row cap; three links still show in full, unscrolled.
export const narrowThreeLinksWithNotices = defineFixture({
  width: NARROWEST_WIDTH,
  render: () => (
    <RuntimeAccessGrantList
      className="border-t border-border/40 pt-3"
      grants={links(3).map((grant) => ({ ...grant, olderPairingMethod: true as const }))}
      currentGrantId="link-0"
      isLoading={false}
      revokingGrantId={null}
      onRevoke={() => {}}
    />
  )
})
