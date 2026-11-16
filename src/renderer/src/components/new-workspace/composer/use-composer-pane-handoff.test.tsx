// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useComposerPaneHandoff } from './use-composer-pane-handoff'

type HandoffProps = {
  composerOpen: boolean
  paneActive: boolean
  workspaceViewActive: boolean
  closeComposer: () => void
}

let root: Root | null = null
let lastHandingOff: boolean | null = null

function Probe(props: HandoffProps) {
  lastHandingOff = useComposerPaneHandoff(props)
  return null
}

function render(
  props: Omit<HandoffProps, 'workspaceViewActive'> & {
    workspaceViewActive?: boolean
  }
) {
  if (!root) {
    root = createRoot(document.createElement('div'))
  }
  act(() => {
    root?.render(<Probe workspaceViewActive {...props} />)
  })
}

describe('useComposerPaneHandoff', () => {
  afterEach(() => {
    act(() => {
      root?.unmount()
    })
    root = null
    lastHandingOff = null
  })

  it('closes the composer when the view leaves the workspace while the pane hosts it', () => {
    const closeComposer = vi.fn()
    render({ composerOpen: true, paneActive: true, closeComposer })
    render({
      composerOpen: true,
      paneActive: false,
      workspaceViewActive: false,
      closeComposer
    })
    expect(lastHandingOff).toBe(true)
    expect(closeComposer).toHaveBeenCalledTimes(1)
  })

  it('lets the dialog open when the composer never went through the pane', () => {
    const closeComposer = vi.fn()
    render({ composerOpen: true, paneActive: false, closeComposer })
    expect(lastHandingOff).toBe(false)
    expect(closeComposer).not.toHaveBeenCalled()
  })

  it('forgets the pane once the composer closes so a later dialog open works', () => {
    const closeComposer = vi.fn()
    render({ composerOpen: true, paneActive: true, closeComposer })
    render({ composerOpen: false, paneActive: false, closeComposer })
    render({ composerOpen: true, paneActive: false, closeComposer })
    expect(lastHandingOff).toBe(false)
    expect(closeComposer).not.toHaveBeenCalled()
  })

  it('keeps the composer open when a creation surface takes the pane in the workspace view', () => {
    const closeComposer = vi.fn()
    render({ composerOpen: true, paneActive: true, closeComposer })
    render({ composerOpen: true, paneActive: false, closeComposer })
    expect(lastHandingOff).toBe(false)
    expect(closeComposer).not.toHaveBeenCalled()
  })

  it('keeps the fallback dialog open when the view later leaves the workspace', () => {
    const closeComposer = vi.fn()
    render({ composerOpen: true, paneActive: true, closeComposer })
    render({ composerOpen: true, paneActive: false, closeComposer })
    render({
      composerOpen: true,
      paneActive: false,
      workspaceViewActive: false,
      closeComposer
    })
    expect(lastHandingOff).toBe(false)
    expect(closeComposer).not.toHaveBeenCalled()
  })
})
