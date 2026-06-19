// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ProjectHeaderActions } from './ProjectHeaderActions'

let root: Root | null = null

describe('ProjectHeaderActions', () => {
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    if (root) {
      act(() => root?.unmount())
      root = null
    }
    document.body.replaceChildren()
  })

  it('overlays hover-only controls instead of reserving project title width', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    act(() => {
      root?.render(<ProjectHeaderActions />)
    })

    const actions = container.querySelector('[data-repo-header-actions]')

    expect(actions?.className).toContain('can-hover:absolute')
    expect(actions?.className).toContain('can-hover:pointer-events-none')
    expect(actions?.className).toContain('group-hover:pointer-events-auto')
    expect(actions?.className).toContain('has-[:focus-visible]:pointer-events-auto')
    expect(actions?.className).toContain('has-[button[data-state=open]]:pointer-events-auto')
  })
})
