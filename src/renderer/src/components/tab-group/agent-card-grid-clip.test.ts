// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { agentCardGridClipPath, findAgentCardGridAnchor } from './agent-card-grid-clip'

const VIEWPORT = { top: 100, right: 400, bottom: 300, left: 0 }

describe('agentCardGridClipPath', () => {
  it('returns no clip for a pane that already fits inside the viewport', () => {
    expect(agentCardGridClipPath({ top: 120, right: 380, bottom: 280, left: 20 }, VIEWPORT)).toBe(
      ''
    )
  })

  it('trims a half-scrolled pane back to the viewport on both axes', () => {
    expect(agentCardGridClipPath({ top: 40, right: 460, bottom: 440, left: -30 }, VIEWPORT)).toBe(
      'inset(60px 60px 140px 30px)'
    )
  })

  it('rounds a sub-pixel overhang up so nothing leaks past the viewport edge', () => {
    expect(agentCardGridClipPath({ top: 99.4, right: 400, bottom: 300, left: 0 }, VIEWPORT)).toBe(
      'inset(1px 0px 0px 0px)'
    )
  })
})

describe('findAgentCardGridAnchor', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('pairs a card body with the scrolling grid that owns it', () => {
    const grid = document.createElement('div')
    grid.dataset.orcaAgentCards = 'wt-1'
    const body = document.createElement('div')
    body.dataset.tabGroupBodyId = 'card-1'
    grid.append(body)
    document.body.append(grid)
    expect(findAgentCardGridAnchor('card-1')).toEqual({ body, viewport: grid })
  })

  it('returns null for an ordinary split pane body and for an unknown group', () => {
    const body = document.createElement('div')
    body.dataset.tabGroupBodyId = 'split-1'
    document.body.append(body)
    expect(findAgentCardGridAnchor('split-1')).toBeNull()
    expect(findAgentCardGridAnchor('missing')).toBeNull()
  })
})
