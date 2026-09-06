// @vitest-environment happy-dom
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useCenterAnchoredEmulatorScroll } from './use-center-anchored-emulator-scroll'
import type { PaneSize } from './emulator-device-frame-layout'

type ScrollHarnessProps = {
  viewportSize: PaneSize
  contentSize: PaneSize
}

function ScrollHarness({ viewportSize, contentSize }: ScrollHarnessProps) {
  const scrollRef = useCenterAnchoredEmulatorScroll(viewportSize, contentSize)
  return <div ref={scrollRef} />
}

function setScrollGeometry(
  node: HTMLDivElement,
  geometry: { clientWidth: number; clientHeight: number; scrollWidth: number; scrollHeight: number }
): void {
  Object.defineProperties(node, {
    clientWidth: { configurable: true, value: geometry.clientWidth },
    clientHeight: { configurable: true, value: geometry.clientHeight },
    scrollWidth: { configurable: true, value: geometry.scrollWidth },
    scrollHeight: { configurable: true, value: geometry.scrollHeight }
  })
}

describe('useCenterAnchoredEmulatorScroll', () => {
  it('centers an axis that starts fitted while preserving the overflowing axis center', () => {
    const viewportSize = { width: 100, height: 100 }
    const initialContentSize = { width: 80, height: 200 }
    const nextContentSize = { width: 300, height: 300 }
    const view = render(
      <ScrollHarness viewportSize={viewportSize} contentSize={initialContentSize} />
    )
    const node = view.container.firstChild as HTMLDivElement

    setScrollGeometry(node, {
      clientWidth: viewportSize.width,
      clientHeight: viewportSize.height,
      scrollWidth: initialContentSize.width,
      scrollHeight: initialContentSize.height
    })
    node.scrollTop = 30
    setScrollGeometry(node, {
      clientWidth: viewportSize.width,
      clientHeight: viewportSize.height,
      scrollWidth: nextContentSize.width,
      scrollHeight: nextContentSize.height
    })

    view.rerender(<ScrollHarness viewportSize={viewportSize} contentSize={nextContentSize} />)

    expect((node.scrollLeft + viewportSize.width / 2) / nextContentSize.width).toBe(0.5)
    expect((node.scrollTop + viewportSize.height / 2) / nextContentSize.height).toBe(0.4)
  })
})
