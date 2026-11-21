// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import type { RuntimeAccessGrant } from '../../../../../../shared/remote-runtime/host-catalog/runtime-access-grants'
import { RuntimeAccessGrantList } from './RuntimeAccessGrantList'

const ROW_STRIDE = 64
const LIST_HEIGHT = 220

function links(count: number): RuntimeAccessGrant[] {
  return Array.from({ length: count }, (_, index) => ({
    deviceId: `link-${index}`,
    name: `Runtime 2026-11-${String(20 - index).padStart(2, '0')}`,
    createdAt: Date.UTC(2026, 10, 20 - index, 15),
    lastSeenAt: null
  }))
}

function renderList(grants: RuntimeAccessGrant[]) {
  const props = {
    currentGrantId: 'link-0',
    isLoading: false,
    revokingGrantId: null,
    onRevoke: () => {}
  }
  const view = render(<RuntimeAccessGrantList grants={grants} {...props} />)
  const scroller = view.container.querySelector<HTMLElement>('.overflow-y-auto')
  if (!scroller) {
    throw new Error('missing scroller')
  }
  // Why: happy-dom has no layout; give the scroller the capped box and its content height.
  let scrollTop = 0
  Object.defineProperties(scroller, {
    clientHeight: { configurable: true, get: () => LIST_HEIGHT },
    scrollHeight: { configurable: true, get: () => grants.length * ROW_STRIDE },
    scrollTop: { configurable: true, get: () => scrollTop, set: (v: number) => (scrollTop = v) }
  })
  const scrollTo = (top: number): void => {
    scroller.scrollTop = top
    fireEvent.scroll(scroller)
  }
  const rerender = (next: RuntimeAccessGrant[]): void =>
    view.rerender(<RuntimeAccessGrantList grants={next} {...props} />)
  return { scroller, scrollTo, rerender }
}

const fade = (scroller: HTMLElement): string =>
  /mask-image:linear-gradient\(([^)]*\))/.exec(scroller.className)?.[1] ?? 'none'

let formatterCount = 0
const RealDateTimeFormat = Intl.DateTimeFormat

beforeEach(() => {
  formatterCount = 0
  // Why: each row builds date formatters while rendering, so the count shows row re-renders.
  Intl.DateTimeFormat = function (...args: ConstructorParameters<typeof Intl.DateTimeFormat>) {
    formatterCount += 1
    return new RealDateTimeFormat(...args)
  } as unknown as typeof Intl.DateTimeFormat
})

afterEach(() => {
  Intl.DateTimeFormat = RealDateTimeFormat
  cleanup()
})

describe('RuntimeAccessGrantList scroller', () => {
  it('fades only the edges that hide rows without re-rendering the rows', () => {
    const { scroller, scrollTo } = renderList(links(12))
    formatterCount = 0

    scrollTo(0)
    expect(fade(scroller)).toMatch(/^to_bottom,black_calc/)
    scrollTo(120)
    expect(fade(scroller)).toMatch(/^to_bottom,transparent,black_1rem,black_calc/)
    scrollTo(140)
    scrollTo(12 * ROW_STRIDE - LIST_HEIGHT)
    expect(fade(scroller)).toBe('to_bottom,transparent,black_1rem)')

    expect(formatterCount).toBe(0)
  })

  it('keeps the same scroller, and its scroll position, when a row is revoked', () => {
    const grants = links(12)
    const { scroller, scrollTo, rerender } = renderList(grants)
    scrollTo(300)

    rerender(grants.filter((grant) => grant.deviceId !== 'link-6'))

    expect(document.querySelector('.overflow-y-auto')).toBe(scroller)
    expect(scroller.scrollTop).toBe(300)
  })
})
