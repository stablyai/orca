// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const toastMocks = vi.hoisted(() => ({
  loading: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  message: vi.fn()
}))

vi.mock('sonner', () => ({ toast: toastMocks }))

import { TooltipProvider } from '@/components/ui/tooltip'
import { installClientHostedPaneApi, paneChannel } from './client-hosted-browser-pane-test-rig'
import { ClientHostedBrowserPagePane } from './ClientHostedBrowserPagePane'

type PopupEvent = {
  browserPageId: string
  origin: string
  action: 'opened-in-orca' | 'opened-external' | 'blocked'
}

let popups = paneChannel<PopupEvent>()

beforeEach(() => {
  popups = paneChannel<PopupEvent>()
  installClientHostedPaneApi({ browser: { onPopup: popups.subscribe } })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function renderPane(): void {
  render(
    <TooltipProvider>
      <ClientHostedBrowserPagePane
        browserTab={
          {
            id: 'page-a',
            url: 'https://example.internal/app',
            title: 'App',
            loading: false,
            canGoBack: false,
            canGoForward: false
          } as never
        }
        workspaceId="workspace-a"
        chromeShortcutScope="focused"
        runtimeEnvironmentId="environment-a"
        worktreeId="worktree-a"
        placement={{
          kind: 'client',
          browserHostClientId: 'client-a',
          browserHostGeneration: 3,
          pageHostGeneration: 7
        }}
        isActive
        onUpdatePageState={vi.fn()}
        onSetUrl={vi.fn()}
      />
    </TooltipProvider>
  )
}

function emitPopup(overrides: Partial<PopupEvent> = {}): void {
  const event: PopupEvent = {
    browserPageId: 'page-a',
    origin: 'https://accounts.example.com',
    action: 'blocked',
    ...overrides
  }
  act(() => popups.emit(event))
}

describe('ClientHostedBrowserPagePane popup notices', () => {
  it('names the origin whose popup was refused', () => {
    renderPane()

    emitPopup()

    expect(toastMocks.message).toHaveBeenCalledWith(
      'https://accounts.example.com tried to open a popup Orca does not support here.',
      { id: 'browser-popup:page-a:blocked:https://accounts.example.com' }
    )
  })

  it('collapses a retrying site onto one notice per origin', () => {
    renderPane()

    emitPopup()
    emitPopup()
    emitPopup()

    expect(toastMocks.message).toHaveBeenCalledTimes(3)
    const ids = toastMocks.message.mock.calls.map((call) => (call[1] as { id: string }).id)
    expect(new Set(ids).size).toBe(1)
  })

  it('silences in-Orca opens but reports external opens', () => {
    renderPane()

    emitPopup({ action: 'opened-in-orca' })
    expect(toastMocks.message).not.toHaveBeenCalled()
    emitPopup({ action: 'opened-external' })
    expect(toastMocks.message).toHaveBeenCalledExactlyOnceWith(
      'https://accounts.example.com opened a new window in your default browser.',
      { id: 'browser-popup:page-a:opened-external:https://accounts.example.com' }
    )
  })

  it('ignores popups belonging to another page', () => {
    renderPane()

    emitPopup({ browserPageId: 'page-b' })

    expect(toastMocks.message).not.toHaveBeenCalled()
  })
})
