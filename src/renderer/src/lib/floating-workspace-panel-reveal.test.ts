import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../shared/constants'
import type { AppState } from '@/store/types'
import { TOGGLE_FLOATING_TERMINAL_EVENT } from './floating-terminal'
import { revealFloatingWorkspacePanel } from './floating-workspace-panel-reveal'

function panelState({ enabled, open }: { enabled: boolean; open: boolean }) {
  return {
    settings: { ...getDefaultSettings('/home/test'), floatingTerminalEnabled: enabled },
    floatingWorkspacePanelOpen: open,
    updateSettings: vi.fn<AppState['updateSettings']>(async () => {})
  }
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
}

function stubWindow() {
  const dispatchEvent = vi.fn()
  const frames: FrameRequestCallback[] = []
  vi.stubGlobal('window', { dispatchEvent })
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback))
  // A DOM a frame behind the store must not decide: it still shows the panel as it was.
  vi.stubGlobal('document', { querySelector: vi.fn().mockReturnValue({}) })
  return { dispatchEvent, runFrames: () => frames.splice(0).forEach((frame) => frame(0)) }
}

afterEach(() => vi.unstubAllGlobals())

describe('revealFloatingWorkspacePanel', () => {
  it('toggles an enabled panel open only while the store says it is closed', () => {
    const { dispatchEvent } = stubWindow()

    revealFloatingWorkspacePanel(panelState({ enabled: true, open: true }))
    expect(dispatchEvent).not.toHaveBeenCalled()

    revealFloatingWorkspacePanel(panelState({ enabled: true, open: false }))
    expect(dispatchEvent).toHaveBeenCalledOnce()
    expect(dispatchEvent.mock.calls[0][0]).toMatchObject({ type: TOGGLE_FLOATING_TERMINAL_EVENT })
  })

  it('enables a disabled panel, then opens it a frame later unless it was left open', async () => {
    const { dispatchEvent, runFrames } = stubWindow()
    const leftOpen = panelState({ enabled: false, open: true })
    const leftClosed = panelState({ enabled: false, open: false })

    revealFloatingWorkspacePanel(leftOpen)
    revealFloatingWorkspacePanel(leftClosed)
    await settle()
    expect(leftOpen.updateSettings).toHaveBeenCalledWith({ floatingTerminalEnabled: true })
    expect(leftClosed.updateSettings).toHaveBeenCalledWith({ floatingTerminalEnabled: true })
    expect(dispatchEvent).not.toHaveBeenCalled()

    runFrames()
    expect(dispatchEvent).toHaveBeenCalledOnce()
  })
})
