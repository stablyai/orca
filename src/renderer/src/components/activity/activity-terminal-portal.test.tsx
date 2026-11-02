/** @vitest-environment happy-dom */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  setActivityTerminalPortals,
  useActivityTerminalPortals,
  type ActivityTerminalPortalTarget
} from './activity-terminal-portal'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root

beforeEach(() => setActivityTerminalPortals([]))

afterEach(() => {
  act(() => root?.unmount())
  setActivityTerminalPortals([])
})

function portal(target: HTMLElement): ActivityTerminalPortalTarget {
  return {
    slotId: 'primary',
    requestToken: 'primary:tab-a:leaf-a',
    target,
    worktreeId: 'worktree-a',
    tabId: 'tab-a',
    paneKey: 'tab-a:leaf-a',
    forceUnavailable: false,
    active: true
  }
}

describe('Activity terminal portal publication', () => {
  it('does not notify Terminal for a value-identical descriptor array', () => {
    const descriptor = portal(document.createElement('div'))
    setActivityTerminalPortals([descriptor])
    let renders = 0

    function Subscriber(): null {
      useActivityTerminalPortals(true)
      renders += 1
      return null
    }

    root = createRoot(document.createElement('div'))
    act(() => root.render(<Subscriber />))
    const initialRenders = renders
    act(() => setActivityTerminalPortals([{ ...descriptor }]))
    expect(renders).toBe(initialRenders)
  })

  it('notifies Terminal when a routing value changes', () => {
    const descriptor = portal(document.createElement('div'))
    setActivityTerminalPortals([descriptor])
    let renders = 0

    function Subscriber(): null {
      useActivityTerminalPortals(true)
      renders += 1
      return null
    }

    root = createRoot(document.createElement('div'))
    act(() => root.render(<Subscriber />))
    const initialRenders = renders
    act(() => setActivityTerminalPortals([{ ...descriptor, paneKey: 'tab-a:leaf-b' }]))
    expect(renders).toBe(initialRenders + 1)
  })
})
