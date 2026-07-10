// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from 'vitest'
import {
  getContextualTourFloatingPosition,
  watchContextualTourFloatingPosition,
  type ContextualTourFloatingPosition,
  type ContextualTourPanelPlacement
} from './contextual-tour-floating-position'

beforeEach(() => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 })
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 960 })
  Object.defineProperty(document.documentElement, 'clientWidth', {
    configurable: true,
    value: 1280
  })
  Object.defineProperty(document.documentElement, 'clientHeight', {
    configurable: true,
    value: 960
  })
})

function elementWithRect(
  rect: Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom' | 'width' | 'height'>
): HTMLElement {
  const element = document.createElement('div')
  element.style.width = `${rect.width}px`
  element.style.height = `${rect.height}px`
  Object.defineProperty(element, 'getBoundingClientRect', {
    value: () => ({ ...rect, x: rect.left, y: rect.top })
  })
  Object.defineProperty(element, 'offsetWidth', { value: rect.width })
  Object.defineProperty(element, 'offsetHeight', { value: rect.height })
  // Why: happy-dom does no layout, so client dimensions default to 0 and a
  // collision boundary element would otherwise read as zero-sized.
  Object.defineProperty(element, 'clientWidth', { value: rect.width })
  Object.defineProperty(element, 'clientHeight', { value: rect.height })
  document.body.appendChild(element)
  return element
}

function arrowElement(): SVGSVGElement {
  const element = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  Object.defineProperty(element, 'getBoundingClientRect', {
    value: () => ({ left: 0, right: 18, top: 0, bottom: 8, width: 18, height: 8, x: 0, y: 0 })
  })
  document.body.appendChild(element)
  return element
}

function expectedStaticArrowSide(placement: ContextualTourPanelPlacement): string {
  return {
    top: 'bottom',
    right: 'left',
    bottom: 'top',
    left: 'right'
  }[placement]
}

describe('contextual tour floating position', () => {
  it('places the panel by the preferred side and returns arrow coordinates', async () => {
    const host = elementWithRect({
      left: 0,
      right: 1024,
      top: 0,
      bottom: 768,
      width: 1024,
      height: 768
    })
    const target = elementWithRect({
      left: 100,
      right: 200,
      top: 200,
      bottom: 240,
      width: 100,
      height: 40
    })
    const panel = elementWithRect({
      left: 0,
      right: 320,
      top: 0,
      bottom: 180,
      width: 320,
      height: 180
    })

    const position = await getContextualTourFloatingPosition({
      arrowElement: arrowElement(),
      floatingElement: panel,
      panelHost: host,
      targetElement: target
    })

    expect(Number.isFinite(Number(position.panelPosition.left))).toBe(true)
    expect(Number.isFinite(Number(position.panelPosition.top))).toBe(true)
    // Why: the arrow starts just outside the panel border so the card outline
    // remains visually clean.
    expect(position.arrowPosition[expectedStaticArrowSide(position.panelPlacement)]).toBe(-8)
  })

  // Regression: a tall step panel inside a small dialog host fit no placement,
  // so it overflowed the host and overflow-hidden clipped its buttons.
  it('keeps the panel inside the host when no placement fits, overlapping the target', async () => {
    const host = elementWithRect({
      left: 300,
      right: 820,
      top: 120,
      bottom: 420,
      width: 520,
      height: 300
    })
    host.style.position = 'fixed'
    const target = elementWithRect({
      left: 400,
      right: 500,
      top: 330,
      bottom: 370,
      width: 100,
      height: 40
    })
    host.appendChild(target)
    const panel = elementWithRect({
      left: 0,
      right: 320,
      top: 0,
      bottom: 180,
      width: 320,
      height: 180
    })
    panel.style.position = 'absolute'
    Object.defineProperty(panel, 'offsetParent', { configurable: true, value: host })
    host.appendChild(panel)

    const position = await getContextualTourFloatingPosition({
      arrowElement: arrowElement(),
      floatingElement: panel,
      panelHost: host,
      preferredPlacement: 'bottom',
      targetElement: target
    })

    const left = Number(position.panelPosition.left)
    const top = Number(position.panelPosition.top)
    expect(left).toBeGreaterThanOrEqual(0)
    expect(left + 320).toBeLessThanOrEqual(520)
    expect(top).toBeGreaterThanOrEqual(0)
    expect(top + 180).toBeLessThanOrEqual(300)
  })

  it('delivers positions continuously while watching and stops after cleanup', async () => {
    const target = elementWithRect({
      left: 100,
      right: 200,
      top: 200,
      bottom: 240,
      width: 100,
      height: 40
    })
    const panel = elementWithRect({
      left: 0,
      right: 320,
      top: 0,
      bottom: 180,
      width: 320,
      height: 180
    })

    const positions: ContextualTourFloatingPosition[] = []
    const stopWatching = watchContextualTourFloatingPosition({
      arrowElement: arrowElement(),
      floatingElement: panel,
      panelHost: null,
      targetElement: target,
      onPosition: (position) => positions.push(position)
    })

    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(positions.length).toBeGreaterThan(0)
    expect(Number.isFinite(Number(positions[0].panelPosition.left))).toBe(true)

    stopWatching()
    const deliveredBeforeStop = positions.length
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(positions.length).toBe(deliveredBeforeStop)
  })

  it.each([
    ['top', { left: 390, top: 208 }],
    ['bottom', { left: 390, top: 452 }],
    ['left', { left: 168, top: 330 }],
    ['right', { left: 612, top: 330 }]
  ] as const)(
    'computes exact viewport coordinates for unhosted %s placement',
    async (placement, expected) => {
      const target = elementWithRect({
        left: 500,
        right: 600,
        top: 400,
        bottom: 440,
        width: 100,
        height: 40
      })
      const panel = elementWithRect({
        left: 0,
        right: 320,
        top: 0,
        bottom: 180,
        width: 320,
        height: 180
      })

      const position = await getContextualTourFloatingPosition({
        arrowElement: arrowElement(),
        floatingElement: panel,
        panelHost: null,
        preferredPlacement: placement,
        targetElement: target
      })

      expect(position.panelPlacement).toBe(placement)
      expect(position.panelPosition).toEqual(expected)
    }
  )

  // Regression: computePosition already returns coordinates relative to the
  // panel's offsetParent (the host). Subtracting the host rect again sent
  // hosted panels (e.g. the workspace-creation dialog tour) off-screen.
  it('positions hosted panels in host-local coordinates without double offset subtraction', async () => {
    const host = elementWithRect({
      left: 300,
      right: 820,
      top: 120,
      bottom: 720,
      width: 520,
      height: 600
    })
    host.style.position = 'fixed'
    const target = elementWithRect({
      left: 400,
      right: 500,
      top: 200,
      bottom: 240,
      width: 100,
      height: 40
    })
    host.appendChild(target)
    const panel = elementWithRect({
      left: 0,
      right: 320,
      top: 0,
      bottom: 180,
      width: 320,
      height: 180
    })
    panel.style.position = 'absolute'
    Object.defineProperty(panel, 'offsetParent', { configurable: true, value: host })
    host.appendChild(panel)

    const position = await getContextualTourFloatingPosition({
      arrowElement: arrowElement(),
      floatingElement: panel,
      panelHost: host,
      preferredPlacement: 'bottom',
      targetElement: target
    })

    // Host-local: target is at (100, 80) inside the host, so a bottom-placed
    // panel sits at target bottom (120) + 12px gap, shifted to stay inside.
    expect(position.panelPosition.top).toBe(132)
    expect(position.panelPosition.left).toBeGreaterThanOrEqual(0)
    expect(Number(position.panelPosition.left)).toBeLessThanOrEqual(520 - 320)
  })
})
