import { act, fireEvent, render as renderWithoutApp, waitFor } from '@testing-library/react'
import { expect, vi, type Mock, type MockInstance } from 'vitest'
import type { Terminal } from '@xterm/xterm'
import { toast } from 'sonner'
import { URL_TO_OPEN } from '@/lib/browser-link-open.test-fixture'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { DashboardCard, DashboardSnapshot } from '../../../../shared/dashboard-snapshot'
import * as standalone from '../standalone-terminal/open-standalone-terminal'
import type { DashboardPreviewLinkSource } from './dashboard-preview-http-actions'
import {
  mountPreviewLinkInteraction,
  observePreviewListeners
} from './dashboard-preview-dom-test-fixture'
import { DashboardPopoutRoot } from './DashboardPopoutRoot'

export async function verifyPopoutDefaultLinkPath({
  source,
  card,
  provider,
  osc,
  readSettings,
  trackInstance,
  pointer,
  screenFor,
  output,
  input,
  openUrl,
  subscribeToRouter
}: {
  source: DashboardPreviewLinkSource
  card: DashboardCard
  provider: MockInstance<Terminal['registerLinkProvider']>
  osc: string
  readSettings: () => GlobalSettings | null
  trackInstance: (instance: standalone.StandaloneTerminal | null) => void
  pointer: (screen: HTMLElement, type: string, options?: MouseEventInit) => MouseEvent
  screenFor: (container: HTMLElement) => HTMLElement
  output: (data: string, ptyId?: string) => Promise<void>
  input: Mock<(pty: string, data: string) => Promise<boolean>>
  openUrl: Mock<(url: string) => Promise<void>>
  subscribeToRouter: Mock
}): Promise<void> {
  const bridges = new Set<object>()
  const subscribe = () => {
    const owner = {}
    bridges.add(owner)
    return () => bridges.delete(owner)
  }
  let snapshot: ((value: DashboardSnapshot) => void) | undefined
  Object.assign(window.api, {
    dashboard: {
      ...window.api.dashboard,
      onSnapshot: (listener: typeof snapshot) => {
        snapshot = listener
        return subscribe()
      },
      requestSnapshot: vi.fn(async () => {})
    },
    agentStatus: { onSet: subscribe, onClear: subscribe },
    ui: {
      ...window.api.ui,
      onAppMenuPaste: subscribe,
      onEditableContextPaste: subscribe,
      onAppMenuSelectionAction: subscribe
    },
    telemetryGetConsentState: async () => ({ effective: 'disabled', reason: 'ci' })
  })
  const constructor = vi.spyOn(standalone, 'openStandaloneTerminal')
  const baseline = mountPreviewLinkInteraction(source, readSettings, trackInstance, false)
  expect(constructor.mock.calls[0]![0].linkHandlers).toBeUndefined()
  expect(provider).toHaveBeenCalledTimes(1)
  baseline.instance.dispose()
  baseline.container.remove()
  const census = observePreviewListeners([])
  const popout = renderWithoutApp(<DashboardPopoutRoot />)
  act(() => snapshot?.({ generatedAt: 3, cards: [card] }))
  expect(bridges.size).toBe(6)
  const rootOwners = Array.from(census.active)
  fireEvent.click(popout.getByRole('button', { name: /Workspace 0/ }))
  expect(window.api.dashboard.ackAgent).toHaveBeenCalledExactlyOnceWith('pane-0', 'explicit')
  await waitFor(() => screenFor(document.body))
  const terminal = constructor.mock.results[1]!.value!.terminal
  expect(constructor.mock.calls[1]![0].linkHandlers).toBeUndefined()
  expect(provider).toHaveBeenCalledTimes(2)
  const raw = 'https:example.com'
  await output(
    `\x1b[?1000h\x1b[?1006h${osc.replace(URL_TO_OPEN, raw)}\r\n${URL_TO_OPEN}\r\n/tmp/plain.txt`
  )
  const screen = screenFor(document.body)
  pointer(screen, 'mousemove', { buttons: 0 })
  await waitFor(() => expect(terminal.element?.getAttribute('title')).toBe(raw))
  pointer(screen, 'mousedown')
  pointer(screen, 'mouseup')
  pointer(screen, 'mousedown', { button: 1, buttons: 4 })
  pointer(screen, 'mouseup', { button: 1 })
  expect(pointer(screen, 'contextmenu', { button: 2, ctrlKey: true }).defaultPrevented).toBe(false)
  await waitFor(() =>
    expect(input.mock.calls.map(([, data]) => data)).toEqual([
      '\x1b[<0;1;1M',
      '\x1b[<0;1;1m',
      '\x1b[<1;1;1M',
      '\x1b[<1;1;1m'
    ])
  )
  expect(openUrl).not.toHaveBeenCalled()
  openUrl.mockRejectedValueOnce(new Error('System unavailable'))
  for (const [clientY, uri] of [
    [7, raw],
    [27, URL_TO_OPEN]
  ] as const) {
    pointer(screen, 'mousemove', { buttons: 0, clientY })
    await waitFor(() => expect(terminal.element?.getAttribute('title')).toBe(uri))
    pointer(screen, 'mousedown', { ctrlKey: true, shiftKey: true, clientY })
    pointer(screen, 'mouseup', { ctrlKey: true, shiftKey: true, clientY })
  }
  await waitFor(() => expect(openUrl.mock.calls.map(([uri]) => uri)).toEqual([raw, URL_TO_OPEN]))
  expect(terminal.hasSelection()).toBe(false)
  pointer(screen, 'mouseleave')
  expect(terminal.element?.getAttribute('title')).toBeNull()
  expect(document.querySelector('[data-link-action-popover], [data-sonner-toaster]')).toBeNull()
  expect(
    popout.queryByRole('button', { name: /Copy link|System Browser|Terminal link settings/ })
  ).toBeNull()
  expect(window.api.ui.writeClipboardText).not.toHaveBeenCalled()
  expect(subscribeToRouter).not.toHaveBeenCalled()
  expect(toast.error).not.toHaveBeenCalled()
  fireEvent.click(popout.getByRole('button', { name: 'Close' }))
  await waitFor(() => expect(document.querySelector('.xterm')).toBeNull())
  expect(Array.from(census.active)).toEqual(rootOwners)
  popout.unmount()
  expect(census.active.size).toBe(0)
  census.restore()
  expect(bridges.size).toBe(0)
  expect(window.api.terminalPreview.unsubscribe).toHaveBeenCalledExactlyOnceWith('pty-1')
}
