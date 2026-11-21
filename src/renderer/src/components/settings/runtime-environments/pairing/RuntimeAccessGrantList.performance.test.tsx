// @vitest-environment happy-dom
// Guards the Active links scroll fades (#46169): fade state that lived in the list re-rendered every
// link row, and re-built its date formatters, each time a scroll crossed an edge. Scrolling must
// leave the rows alone.
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { RuntimeAccessGrant } from '../../../../../../shared/remote-runtime/host-catalog/runtime-access-grants'
import { RuntimeAccessGrantList } from './RuntimeAccessGrantList'

afterEach(() => {
  vi.restoreAllMocks()
  cleanup()
})

const LINKS: RuntimeAccessGrant[] = Array.from({ length: 12 }, (_, index) => ({
  deviceId: `link-${index}`,
  name: `Runtime 2026-11-${String(20 - index).padStart(2, '0')}`,
  createdAt: Date.UTC(2026, 10, 20 - index, 15),
  lastSeenAt: null
}))

it('scrolling the links past either edge builds no row date formatters', () => {
  const { getAllByRole } = render(
    <RuntimeAccessGrantList
      grants={LINKS}
      currentGrantId="link-0"
      isLoading={false}
      revokingGrantId={null}
      onRevoke={() => {}}
    />
  )
  const scroller = getAllByRole('button')[0]?.parentElement?.parentElement
  if (!scroller) {
    throw new Error('missing link list')
  }
  // Why: happy-dom has no layout; 12 rows of 64px in a 220px box.
  let scrollTop = 0
  Object.defineProperties(scroller, {
    clientHeight: { configurable: true, get: () => 220 },
    scrollHeight: { configurable: true, get: () => 768 },
    scrollTop: {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value
      }
    }
  })
  const formatters = vi.spyOn(Intl, 'DateTimeFormat')

  for (const top of [0, 120, 140, 548, 300, 0]) {
    scroller.scrollTop = top
    fireEvent.scroll(scroller)
  }

  expect(formatters).not.toHaveBeenCalled()
})
