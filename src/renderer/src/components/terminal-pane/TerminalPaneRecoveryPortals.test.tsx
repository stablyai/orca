// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CALM_STATUS_MIN_VISIBLE_MS,
  CALM_STATUS_REVEAL_DELAY_MS
} from '../../../../shared/calm-status-reveal'
import type { TerminalPaneController } from './use-terminal-pane-controller'
import { resetRemoteServerNoticeClaimsForTests } from './remote-server-notice-claims'

const outage = vi.hoisted((): { environmentId: string | null } => ({ environmentId: 'env-1' }))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, options?: Record<string, string>) =>
    fallback.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => options?.[name] ?? ''),
  getIntlLocale: () => 'en-US'
}))
vi.mock('@/store', () => ({ useAppStore: (selector: (state: unknown) => unknown) => selector({}) }))
vi.mock('./use-wsl-host-unavailable-reason', () => ({ useWslHostUnavailableReason: () => null }))
vi.mock('./use-managed-pairing-refused', () => ({
  useManagedPairingRefusedEnvironmentId: () => null
}))
vi.mock('./remote-server-outage', () => ({
  useWorkspaceRuntimeEnvironmentId: () => 'env-1',
  useRetryingOutageEnvironmentId: () => outage.environmentId,
  selectRuntimeServerName: () => 'Desk',
  selectRuntimeServerTailscaleHost: () => null,
  selectRemoteServerOutageCause: () => 'connection-lost'
}))

afterEach(() => {
  outage.environmentId = 'env-1'
  cleanup()
  resetRemoteServerNoticeClaimsForTests()
  document.body.innerHTML = ''
  vi.useRealTimers()
})

function controllerFor(panes: HTMLElement[]): TerminalPaneController {
  const transport = { getRuntimeEnvironmentId: () => 'env-1' }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the recovery portals read only these fields of the pane controller.
  return {
    managedPanes: panes.map((container, index) => ({ id: index + 1, container })),
    ptyRecoveryStatesByPaneId: Object.fromEntries(
      panes.map((_, index) => [index + 1, { phase: 'backoff', epoch: 1, attempt: 1 }])
    ),
    paneTransportsRef: { current: new Map(panes.map((_, index) => [index + 1, transport])) },
    showSshReconnectOverlay: false,
    worktreeId: 'wt-1',
    isVisible: true,
    isolatedPaneKey: null
  } as unknown as TerminalPaneController
}

describe('TerminalPaneRecoveryPortals', () => {
  it('says a server-wide drop once for the tab and keeps every split pane quiet', async () => {
    vi.useFakeTimers()
    const { TerminalPaneRecoveryPortals } = await import('./TerminalPaneRecoveryPortals')
    const panes = [document.createElement('div'), document.createElement('div')]
    panes.forEach((pane) => document.body.appendChild(pane))
    const view = render(<TerminalPaneRecoveryPortals controller={controllerFor(panes)} />)

    act(() => vi.advanceTimersByTime(CALM_STATUS_REVEAL_DELAY_MS))

    expect(view.container.querySelectorAll('[data-remote-server-outage-notice]')).toHaveLength(1)
    expect(
      document.querySelectorAll('[data-terminal-remote-runtime-reconnect-banner]')
    ).toHaveLength(0)
  })

  it('keeps every surface on the server quiet through the notice hold, then lets a still-down pane speak', async () => {
    vi.useFakeTimers()
    const { TerminalPaneRecoveryPortals } = await import('./TerminalPaneRecoveryPortals')
    const leftPane = document.createElement('div')
    const rightPane = document.createElement('div')
    document.body.append(leftPane, rightPane)
    const left = controllerFor([leftPane])
    const right = controllerFor([rightPane])
    const surfaces = (l: TerminalPaneController, r: TerminalPaneController) => (
      <>
        <TerminalPaneRecoveryPortals controller={l} />
        <TerminalPaneRecoveryPortals controller={r} />
      </>
    )
    const view = render(surfaces(left, right))
    act(() => vi.advanceTimersByTime(CALM_STATUS_REVEAL_DELAY_MS * 2))
    const notices = () => view.container.querySelectorAll('[data-remote-server-outage-notice]')
    const paneBanners = () =>
      document.querySelectorAll('[data-terminal-remote-runtime-reconnect-banner]')
    expect(notices()).toHaveLength(1)

    outage.environmentId = null
    view.rerender(surfaces({ ...left }, { ...right }))
    expect(notices()).toHaveLength(1)
    expect(paneBanners()).toHaveLength(0)

    act(() => vi.advanceTimersByTime(CALM_STATUS_MIN_VISIBLE_MS))
    expect(notices()).toHaveLength(0)
    expect(paneBanners()).toHaveLength(2)
  })

  it('lets a pane waiting for SSH sign-in say so at once instead of a server notice', async () => {
    vi.useFakeTimers()
    const { TerminalPaneRecoveryPortals } = await import('./TerminalPaneRecoveryPortals')
    const pane = document.createElement('div')
    document.body.append(pane)
    const base = controllerFor([pane])
    const controller = {
      ...base,
      ptyRecoveryStatesByPaneId: {
        1: { phase: 'backoff' as const, epoch: 1, attempt: 1, reason: 'ssh-sign-in' as const }
      }
    }
    const view = render(<TerminalPaneRecoveryPortals controller={controller} />)

    expect(
      document.querySelectorAll('[data-terminal-remote-runtime-reconnect-banner="ssh-sign-in"]')
    ).toHaveLength(1)
    act(() => vi.advanceTimersByTime(CALM_STATUS_REVEAL_DELAY_MS * 2))
    expect(view.container.querySelectorAll('[data-remote-server-outage-notice]')).toHaveLength(0)
  })

  it('drops a visible notice at once when a pane starts waiting for SSH sign-in', async () => {
    vi.useFakeTimers()
    const { TerminalPaneRecoveryPortals } = await import('./TerminalPaneRecoveryPortals')
    const pane = document.createElement('div')
    document.body.append(pane)
    const controller = controllerFor([pane])
    const view = render(<TerminalPaneRecoveryPortals controller={controller} />)
    act(() => vi.advanceTimersByTime(CALM_STATUS_REVEAL_DELAY_MS * 2))
    expect(view.container.querySelectorAll('[data-remote-server-outage-notice]')).toHaveLength(1)

    view.rerender(
      <TerminalPaneRecoveryPortals
        controller={{
          ...controller,
          ptyRecoveryStatesByPaneId: {
            1: { phase: 'backoff' as const, epoch: 1, attempt: 1, reason: 'ssh-sign-in' as const }
          }
        }}
      />
    )

    expect(view.container.querySelectorAll('[data-remote-server-outage-notice]')).toHaveLength(0)
    expect(
      document.querySelectorAll('[data-terminal-remote-runtime-reconnect-banner="ssh-sign-in"]')
    ).toHaveLength(1)
  })

  it('never shows two notices when the speaker hides and returns during an ongoing outage', async () => {
    vi.useFakeTimers()
    const { TerminalPaneRecoveryPortals } = await import('./TerminalPaneRecoveryPortals')
    const leftPane = document.createElement('div')
    const rightPane = document.createElement('div')
    document.body.append(leftPane, rightPane)
    const left = controllerFor([leftPane])
    const right = controllerFor([rightPane])
    const surfaces = (l: TerminalPaneController) => (
      <>
        <TerminalPaneRecoveryPortals controller={l} />
        <TerminalPaneRecoveryPortals controller={right} />
      </>
    )
    const view = render(surfaces(left))
    act(() => vi.advanceTimersByTime(CALM_STATUS_REVEAL_DELAY_MS * 2))
    const notices = () => view.container.querySelectorAll('[data-remote-server-outage-notice]')

    view.rerender(surfaces({ ...left, isVisible: false }))
    view.rerender(surfaces({ ...left, isVisible: true }))
    expect(notices()).toHaveLength(1)

    outage.environmentId = null
    view.rerender(surfaces({ ...left, isVisible: true }))
    expect(notices()).toHaveLength(1)
  })
})
