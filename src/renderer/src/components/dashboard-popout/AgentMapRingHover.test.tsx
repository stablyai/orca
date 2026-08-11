// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { fireEvent } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { card, installAgentMapEnvironment, renderMap } from './agent-map-render-test-harness'

/** A ring has to stay open for as long as the pointer is working inside it —
 *  across its own contents, and across a pan drag that takes pointer capture. */
describe('AgentMap ring hover', () => {
  installAgentMapEnvironment()

  it('reveals the hovered workspace name and agent count above every other label', () => {
    const { container } = renderMap([
      card(),
      card({ paneKey: 'pane-2', conversationName: 'Agent beta' })
    ])
    expect(container.querySelector('[data-agent-map-hover-label]')).not.toBeInTheDocument()

    fireEvent.pointerOver(container.querySelector('.agent-map-worktree-group')!)

    const hovered = container.querySelector('[data-agent-map-hover-label]')!
    expect(hovered.querySelector('.agent-map-worktree-label')).toHaveTextContent('Agent map')
    expect(hovered.querySelector('.agent-map-worktree-count')).toHaveTextContent('2 agents')
    expect(hovered.querySelector('.agent-map-worktree-label-group')).toHaveClass(
      'is-active',
      'is-count-visible'
    )
    // The hovered name is hoisted, not duplicated, and draws after every ring.
    const labels = container.querySelectorAll('.agent-map-worktree-label-group')
    expect(labels).toHaveLength(1)
    const lastRing = [...container.querySelectorAll('[data-agent-map-worktree]')].at(-1)!
    expect(lastRing.compareDocumentPosition(labels[0]) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(4)
  })

  it('hides the hovered workspace label again when the pointer leaves', () => {
    const { container } = renderMap([card()])
    const group = container.querySelector('.agent-map-worktree-group')!

    fireEvent.pointerOver(group)
    expect(container.querySelector('[data-agent-map-hover-label]')).toBeInTheDocument()

    fireEvent.pointerOut(group)
    expect(container.querySelector('[data-agent-map-hover-label]')).not.toBeInTheDocument()
  })

  it('keeps the pressed rings lit for the whole pan drag', () => {
    const { container } = renderMap([card()])
    const svg = container.querySelector('svg')!
    const projectRing = container.querySelector('[data-agent-map-project-id]')!
    const worktreeGroup = container.querySelector('.agent-map-worktree-group')!
    // Pointer capture retargets :hover to the <svg> mid-gesture, so CSS alone
    // cannot hold the ring open — the class has to survive the drag.
    fireEvent.pointerDown(projectRing, { button: 0, pointerId: 1 })

    expect(projectRing).toHaveClass('is-held')

    fireEvent.pointerMove(svg, { pointerId: 1, clientX: 40, clientY: 24 })
    expect(projectRing).toHaveClass('is-held')

    fireEvent.pointerUp(svg, { pointerId: 1 })
    expect(projectRing).not.toHaveClass('is-held')
    expect(worktreeGroup).not.toHaveClass('is-held')
  })

  it('holds the workspace name up while panning from inside that workspace', () => {
    const { container } = renderMap([card()])
    const svg = container.querySelector('svg')!
    const worktreeGroup = container.querySelector('[data-agent-map-worktree-id]')!
    // The aggregate bubble sits inside the group but is not the ring, so a press
    // there pans rather than opening the workspace popover.
    fireEvent.pointerDown(worktreeGroup, { button: 0, pointerId: 1 })
    fireEvent.pointerMove(svg, { pointerId: 1, clientX: 40, clientY: 24 })

    expect(worktreeGroup).toHaveClass('is-held')
    expect(container.querySelector('[data-agent-map-hover-label]')).toBeInTheDocument()
  })

  it('drops the held rings when the pan is cancelled', () => {
    const { container } = renderMap([card()])
    const svg = container.querySelector('svg')!
    const projectRing = container.querySelector('[data-agent-map-project-id]')!

    fireEvent.pointerDown(projectRing, { button: 0, pointerId: 1 })
    fireEvent.pointerCancel(svg, { pointerId: 1 })

    expect(projectRing).not.toHaveClass('is-held')
  })

  it('drops the held rings and drag when pointer capture is lost', () => {
    const { container } = renderMap([card()])
    const svg = container.querySelector('svg')!
    const projectRing = container.querySelector('[data-agent-map-project-id]')!

    fireEvent.pointerDown(projectRing, { button: 0, pointerId: 1 })
    fireEvent.lostPointerCapture(svg, { pointerId: 1 })

    expect(projectRing).not.toHaveClass('is-held')
  })

  it('keeps a focused workspace label visible after its pointer leaves', () => {
    const { container } = renderMap([card()])
    const group = container.querySelector('.agent-map-worktree-group')!
    const ring = container.querySelector<SVGCircleElement>('.agent-map-worktree-ring')!

    ring.focus()
    fireEvent.pointerOver(group)
    fireEvent.pointerOut(group)

    expect(container.querySelector('[data-agent-map-hover-label]')).toBeInTheDocument()
  })

  it('keeps a hovered workspace label visible after its focus leaves', () => {
    const { container } = renderMap([card()])
    const group = container.querySelector('.agent-map-worktree-group')!
    const ring = container.querySelector<SVGCircleElement>('.agent-map-worktree-ring')!

    fireEvent.pointerOver(group)
    ring.focus()
    ring.blur()

    expect(container.querySelector('[data-agent-map-hover-label]')).toBeInTheDocument()
  })
})
