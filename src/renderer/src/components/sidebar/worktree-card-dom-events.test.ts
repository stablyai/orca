// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'
import { isEventTargetInsideCurrentTarget } from './worktree-card-dom-events'

describe('worktree card DOM events', () => {
  it('recognizes DOM events that originate inside the current target', () => {
    const currentTarget = document.createElement('div')
    const child = document.createElement('button')
    currentTarget.appendChild(child)

    expect(isEventTargetInsideCurrentTarget(currentTarget, child)).toBe(true)
  })

  it('rejects portaled DOM events that bubble through the React tree', () => {
    const currentTarget = document.createElement('div')
    const portaledTarget = document.createElement('button')

    expect(isEventTargetInsideCurrentTarget(currentTarget, portaledTarget)).toBe(false)
  })

  it('supports text-node event targets inside the current target', () => {
    const currentTarget = document.createElement('div')
    const textTarget = document.createTextNode('Rename')
    currentTarget.appendChild(textTarget)

    expect(isEventTargetInsideCurrentTarget(currentTarget, textTarget)).toBe(true)
  })
})
