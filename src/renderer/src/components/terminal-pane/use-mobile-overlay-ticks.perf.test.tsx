// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { hydrateDrivers, setDriverForPty } from '@/lib/pane-manager/mobile-driver-state'
import { hydrateOverrides, setFitOverride } from '@/lib/pane-manager/mobile-fit-overrides'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import type { PtyTransport } from './pty-transport-types'
import { useMobileOverlayTicks } from './use-mobile-overlay-ticks'

// Real listener sets reproduce N-subscriber fanout without emitter mocks.
const SUBSCRIBER_COUNT = 10
const FOREIGN_EVENT_COUNT = 20

const emptyManagerRef = { current: { getPanes: () => [] } as unknown as PaneManager }

type PaneTransportsRef = { current: ReadonlyMap<number, Pick<PtyTransport, 'getPtyId'>> }

function paneTransportsRefFor(ptyId: string): PaneTransportsRef {
  return { current: new Map([[1, { getPtyId: () => ptyId }]]) }
}

function Subscriber({
  paneTransportsRef,
  onRender
}: {
  paneTransportsRef: PaneTransportsRef
  onRender: () => void
}): null {
  useMobileOverlayTicks({ managerRef: emptyManagerRef, paneTransportsRef })
  onRender()
  return null
}

function ownedPtyId(index: number): string {
  return `owned-pty-${index}`
}

function mountSubscribers(): { renders: number[]; resetCounts: () => void } {
  const renders = Array.from({ length: SUBSCRIBER_COUNT }, () => 0)
  const transportRefs = renders.map((_, index) => paneTransportsRefFor(ownedPtyId(index)))
  render(
    <>
      {transportRefs.map((paneTransportsRef, index) => (
        <Subscriber
          key={ownedPtyId(index)}
          paneTransportsRef={paneTransportsRef}
          onRender={() => {
            renders[index] += 1
          }}
        />
      ))}
    </>
  )
  return {
    renders,
    resetCounts: () => renders.fill(0)
  }
}

// Use one act per event to preserve independent IPC/network commit boundaries instead of hiding the render storm through batching.
function emitInOwnTask(emit: () => void): void {
  act(() => {
    emit()
  })
}

describe('useMobileOverlayTicks pty-affinity gate', () => {
  afterEach(() => {
    cleanup()
    hydrateOverrides([])
    hydrateDrivers([])
  })

  it('does not re-render subscribers for fit-override events on unowned ptys', () => {
    const { renders, resetCounts } = mountSubscribers()
    resetCounts()

    for (let i = 0; i < FOREIGN_EVENT_COUNT; i++) {
      emitInOwnTask(() => setFitOverride(`foreign-pty-${i}`, 'mobile-fit', 40, 20))
    }

    expect(renders).toEqual(Array.from({ length: SUBSCRIBER_COUNT }, () => 0))
  })

  it('does not re-render subscribers for driver events on unowned ptys', () => {
    const { renders, resetCounts } = mountSubscribers()
    resetCounts()

    for (let i = 0; i < FOREIGN_EVENT_COUNT; i++) {
      emitInOwnTask(() =>
        setDriverForPty(`foreign-pty-${i}`, { kind: 'mobile', clientId: `client-${i}` })
      )
    }

    expect(renders).toEqual(Array.from({ length: SUBSCRIBER_COUNT }, () => 0))
  })

  it('still re-renders exactly the owning subscriber for its own pty events', () => {
    const { renders, resetCounts } = mountSubscribers()
    resetCounts()

    emitInOwnTask(() => setFitOverride(ownedPtyId(3), 'mobile-fit', 40, 20))
    expect(renders[3]).toBe(1)

    emitInOwnTask(() => setDriverForPty(ownedPtyId(7), { kind: 'mobile', clientId: 'phone' }))
    expect(renders[7]).toBe(1)

    expect(renders.reduce((total, count) => total + count, 0)).toBe(2)
  })

  it('keeps a full handle-rotation storm proportional to the panes that rotated', () => {
    const { renders, resetCounts } = mountSubscribers()
    resetCounts()

    // Model reconnect handle rotation republishing overlay state and retiring the prior binding.
    for (let index = 0; index < SUBSCRIBER_COUNT; index++) {
      emitInOwnTask(() => {
        setFitOverride(ownedPtyId(index), 'mobile-fit', 40, 20)
        setFitOverride(`rotated-away-${index}`, 'desktop-fit', 40, 20)
      })
    }

    // One commit per rotating pane, in its own tab — not SUBSCRIBER_COUNT commits each.
    expect(renders).toEqual(Array.from({ length: SUBSCRIBER_COUNT }, () => 1))
  })
})
