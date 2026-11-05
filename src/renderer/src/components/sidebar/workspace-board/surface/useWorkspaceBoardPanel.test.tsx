// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useWorkspaceBoardPanel, type WorkspaceBoardPanelState } from './useWorkspaceBoardPanel'

const mocks = vi.hoisted(() => ({
  recordFeatureInteraction: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      recordFeatureInteraction: mocks.recordFeatureInteraction
    })
  }
}))

let latestState: WorkspaceBoardPanelState | null = null
const roots: Root[] = []

function HookProbe(): null {
  latestState = useWorkspaceBoardPanel()
  return null
}

async function renderHookProbe(): Promise<void> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => {
    root.render(<HookProbe />)
  })
}

function panelState(): WorkspaceBoardPanelState {
  if (!latestState) {
    throw new Error('Hook state has not been rendered')
  }
  return latestState
}

async function updatePanel(update: (state: WorkspaceBoardPanelState) => void): Promise<void> {
  await act(async () => {
    update(panelState())
  })
}

async function pressEscape(from: EventTarget = document): Promise<void> {
  await act(async () => {
    from.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })
}

describe('useWorkspaceBoardPanel', () => {
  beforeEach(() => {
    latestState = null
    mocks.recordFeatureInteraction.mockReset()
  })

  afterEach(() => {
    roots.splice(0).forEach((root) => {
      act(() => root.unmount())
    })
    document.body.replaceChildren()
  })

  it('keeps the dismissal Escape from reaching a focused terminal', async () => {
    await renderHookProbe()
    const terminalInput = document.createElement('textarea')
    terminalInput.className = 'xterm-helper-textarea'
    document.body.appendChild(terminalInput)
    const terminalKeyDown = vi.fn()
    terminalInput.addEventListener('keydown', terminalKeyDown)

    await updatePanel((state) => state.openWorkspaceBoard())
    await pressEscape(terminalInput)

    expect(panelState().workspaceBoardOpen).toBe(false)
    expect(terminalKeyDown).not.toHaveBeenCalled()
  })
})
