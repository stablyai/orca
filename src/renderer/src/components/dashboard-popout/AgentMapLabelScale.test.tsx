// @vitest-environment happy-dom

import { waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import {
  AGENT_MAP_AGENT_LABEL_FONT_SIZE,
  AGENT_MAP_AGENT_LABEL_MIN_RENDERED_FONT_SIZE
} from './agent-map-agent-label-metrics'
import { card, installAgentMapEnvironment, renderMap } from './agent-map-render-test-harness'

const CANVAS_BOUNDS = {
  x: 0,
  y: 0,
  left: 0,
  top: 0,
  right: 480,
  bottom: 360,
  width: 480,
  height: 360,
  toJSON: () => ({})
}

class ImmediateResizeObserver {
  readonly callback: ResizeObserverCallback

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback
  }

  observe(): void {
    this.callback([], this as unknown as ResizeObserver)
  }

  disconnect(): void {}
  unobserve(): void {}
}

type ScreenBounds = {
  left: number
  right: number
  top: number
  bottom: number
}

function renderedLabelBounds(
  container: HTMLElement,
  viewX: number,
  viewY: number,
  mapScale: number
): ScreenBounds[] {
  return [...container.querySelectorAll<SVGGElement>('[data-agent-map-agent]')].map((node) => {
    const nodeMatch = node.getAttribute('transform')?.match(/translate\(([^ ]+) ([^)]+)\)/)
    const nodeX = Number(nodeMatch?.[1])
    const nodeY = Number(nodeMatch?.[2])
    const group = node.querySelector<SVGGElement>('.agent-map-agent-label-group')!
    const labelScale = Number(group.getAttribute('transform')?.match(/scale\(([^)]+)\)/)?.[1])
    const frame = group.querySelector<SVGForeignObjectElement>('.agent-map-agent-label-frame')!
    const x = nodeX + Number(frame.getAttribute('x')) * labelScale
    const y = nodeY + Number(frame.getAttribute('y')) * labelScale
    const width = Number(frame.getAttribute('width')) * labelScale
    const height = Number(frame.getAttribute('height')) * labelScale
    return {
      left: (x - viewX) * mapScale,
      right: (x + width - viewX) * mapScale,
      top: (y - viewY) * mapScale,
      bottom: (y + height - viewY) * mapScale
    }
  })
}

function overlaps(first: ScreenBounds, second: ScreenBounds): boolean {
  return (
    first.left < second.right &&
    first.right > second.left &&
    first.top < second.bottom &&
    first.bottom > second.top
  )
}

describe('AgentMap label scale', () => {
  const environment = installAgentMapEnvironment()

  it('fits dense low-zoom agent labels without overlap', async () => {
    const zeroBounds = { ...CANVAS_BOUNDS, right: 0, bottom: 0, width: 0, height: 0 }
    environment.boundsSpy.mockImplementation(function getBounds(this: Element) {
      return this.classList.contains('agent-map-canvas') || this instanceof SVGSVGElement
        ? CANVAS_BOUNDS
        : zeroBounds
    })
    vi.stubGlobal('ResizeObserver', ImmediateResizeObserver)
    const parent = card({
      paneKey: 'parent',
      ptyId: 'pty-parent',
      tabId: 'tab-parent',
      leafId: 'leaf-parent',
      conversationName: 'Agent 00'
    })
    const children = Array.from({ length: 19 }, (_, index) =>
      card({
        paneKey: `child-${index}`,
        ptyId: `pty-child-${index}`,
        tabId: `tab-child-${index}`,
        leafId: `leaf-child-${index}`,
        parentPaneKey: parent.paneKey,
        conversationName: `Agent ${String(index + 1).padStart(2, '0')}`
      })
    )
    const { container } = renderMap([parent, ...children])
    const svg = container.querySelector<SVGSVGElement>('.agent-map-canvas > svg')!
    await waitFor(() => {
      const viewWidth = Number(svg.getAttribute('viewBox')?.split(' ')[2])
      expect(CANVAS_BOUNDS.width / viewWidth).toBeLessThan(1)
    })
    const [viewX, viewY, viewWidth] = svg.getAttribute('viewBox')!.split(' ').map(Number)
    const bounds = renderedLabelBounds(container, viewX, viewY, CANVAS_BOUNDS.width / viewWidth)
    expect(bounds).toHaveLength(20)

    for (const [index, label] of bounds.entries()) {
      expect(label.left).toBeGreaterThanOrEqual(0)
      expect(label.right).toBeLessThanOrEqual(CANVAS_BOUNDS.width)
      expect(label.top).toBeGreaterThanOrEqual(0)
      expect(label.bottom).toBeLessThanOrEqual(CANVAS_BOUNDS.height)
      for (const other of bounds.slice(index + 1)) {
        expect(overlaps(label, other), JSON.stringify({ label, other })).toBe(false)
      }
    }
  })

  it.each([1, 9, 16])(
    'keeps labels readable and collision-free across %s projects at 480px',
    async (projectCount) => {
      const zeroBounds = { ...CANVAS_BOUNDS, right: 0, bottom: 0, width: 0, height: 0 }
      environment.boundsSpy.mockImplementation(function getBounds(this: Element) {
        return this.classList.contains('agent-map-canvas') || this instanceof SVGSVGElement
          ? CANVAS_BOUNDS
          : zeroBounds
      })
      vi.stubGlobal('ResizeObserver', ImmediateResizeObserver)
      const cards = Array.from({ length: projectCount }, (_, index) =>
        card({
          paneKey: `agent-${index}`,
          ptyId: `pty-${index}`,
          tabId: `tab-${index}`,
          leafId: `leaf-${index}`,
          repoId: `repo-${index}`,
          repoName: `Project ${index}`,
          worktreeId: `worktree-${index}`,
          worktreeName: `Workspace ${index}`,
          conversationName: `Agent ${index}`
        })
      )
      const { container } = renderMap(cards)
      const svg = container.querySelector<SVGSVGElement>('.agent-map-canvas > svg')!
      await waitFor(() => expect(svg.getAttribute('viewBox')).not.toBeNull())
      const [viewX, viewY, viewWidth] = svg.getAttribute('viewBox')!.split(' ').map(Number)
      const mapScale = CANVAS_BOUNDS.width / viewWidth
      const bounds = renderedLabelBounds(container, viewX, viewY, mapScale)
      const labelGroups = container.querySelectorAll<SVGGElement>('.agent-map-agent-label-group')

      expect(bounds).toHaveLength(projectCount)
      for (const group of labelGroups) {
        const scale = Number(group.getAttribute('transform')?.match(/scale\(([^)]+)\)/)?.[1])
        expect(AGENT_MAP_AGENT_LABEL_FONT_SIZE * scale * mapScale).toBeGreaterThanOrEqual(
          AGENT_MAP_AGENT_LABEL_MIN_RENDERED_FONT_SIZE - 0.01
        )
      }
      for (const [index, label] of bounds.entries()) {
        expect(label.left).toBeGreaterThanOrEqual(0)
        expect(label.right).toBeLessThanOrEqual(CANVAS_BOUNDS.width)
        expect(label.top).toBeGreaterThanOrEqual(0)
        expect(label.bottom).toBeLessThanOrEqual(CANVAS_BOUNDS.height)
        for (const other of bounds.slice(index + 1)) {
          expect(overlaps(label, other)).toBe(false)
        }
      }
    }
  )
})
