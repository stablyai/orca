// @vitest-environment happy-dom
import type { ReactNode } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { PtyManagementSession } from '../../../../preload/api-types'
import { TerminalPane } from './TerminalPane'

const fake = vi.hoisted(() => ({
  query: '',
  isWindows: false,
  isMac: false,
  listSessions: vi.fn(async () => ({ sessions: [] })),
  attribution: vi.fn(async () => ({ health: 'intact' })),
  tabs: {},
  ptys: {},
  action: vi.fn(),
  session: {
    sessionId: 'synthetic-session',
    state: 'running' as const,
    shellState: 'ready' as const,
    isAlive: true,
    pid: null,
    cwd: null,
    cols: 80,
    rows: 24,
    createdAt: 0,
    protocolVersion: 1
  }
}))
vi.mock('@/i18n/i18n', () => ({
  i18n: { language: 'en' },
  translate: (_key: string, fallback: string) => fallback
}))
vi.mock('@/store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      settingsSearchQuery: fake.query,
      tabsByWorktree: fake.tabs,
      ptyIdsByTabId: fake.ptys,
      setActiveView: fake.action,
      closeSettingsPage: fake.action,
      openSettingsTarget: fake.action,
      openSettingsPage: fake.action,
      setSettingsSearchQuery: fake.action
    })
}))
vi.mock('@/components/terminal-pane/pane-helpers', () => ({
  isMacUserAgent: () => fake.isMac,
  isWindowsUserAgent: () => fake.isWindows
}))
vi.mock('@/lib/keyboard-layout/use-effective-mac-option-as-alt', () => ({
  useDetectedOptionAsAlt: () => 'us'
}))
vi.mock('@/components/settings/TerminalInteractionSection', () => ({
  TerminalInteractionSection: () => null
}))
vi.mock('@/components/settings/TerminalRenderingSection', () => ({
  TerminalRenderingSection: () => null
}))
vi.mock('@/components/settings/TerminalSetupScriptSection', () => ({
  TerminalSetupScriptSection: () => null
}))
vi.mock('@/components/settings/TerminalWindowsShellSection', () => ({
  TerminalWindowsShellSection: () => null
}))
vi.mock('@/components/settings/SearchableSetting', () => ({
  SearchableSetting: ({ children }: { children: ReactNode }) => <>{children}</>
}))
vi.mock('@/components/settings/ManageSessionsTable', () => ({
  ManageSessionsTable: ({
    onRefresh,
    onRequestKill
  }: {
    onRefresh: () => void
    onRequestKill: (session: PtyManagementSession) => void
  }) => (
    <>
      <button onClick={onRefresh}>Refresh sessions</button>
      <button onClick={() => onRequestKill(fake.session)}>Preview session action</button>
    </>
  )
}))
vi.mock('@/components/settings/ManageSessionKillDialog', () => ({
  ManageSessionKillDialog: ({ session }: { session: PtyManagementSession | null }) =>
    session ? <span>Pending action for {session.sessionId}</span> : null
}))
vi.mock('@/components/shared/useDaemonActions', () => ({
  useDaemonActions: () => ({ isBusy: false, busyKind: null, setPending: fake.action }),
  DaemonActionDialog: () => null
}))
vi.mock('@/lib/worktree-activation', () => ({ activateAndRevealWorktree: vi.fn() }))
vi.mock('@/lib/activate-tab-and-focus-pane', () => ({ activateTabAndFocusPane: vi.fn() }))

beforeEach(() => {
  vi.clearAllMocks()
  fake.query = ''
  fake.isWindows = false
  fake.isMac = false
  Object.assign(window, {
    api: {
      pty: {
        management: {
          listSessions: fake.listSessions,
          macTccAttribution: fake.attribution
        }
      }
    }
  })
})
afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'api')
})

function paneProps() {
  return {
    settings: getDefaultSettings('/synthetic'),
    updateSettings: vi.fn(),
    scrollbackMode: 'preset' as const,
    setScrollbackMode: vi.fn()
  }
}

it.each([
  { name: 'Unix client and host', isWindows: false, isMac: false, hostIsWindows: false },
  { name: 'Windows client and host', isWindows: true, isMac: false, hostIsWindows: true },
  { name: 'Mac client and Windows host', isWindows: false, isMac: true, hostIsWindows: true }
])('keeps retained session sections mounted on $name', async (platform) => {
  fake.isWindows = platform.isWindows
  fake.isMac = platform.isMac
  const props = { ...paneProps(), isWindowsTerminalHost: platform.hostIsWindows }
  const view = render(<TerminalPane {...props} />)
  await act(async () => {})
  for (const query of [
    'm',
    'ma',
    'man',
    'mana',
    'manag',
    'manage',
    '',
    't',
    'te',
    'ter',
    'term',
    'termi',
    'termin',
    'termina',
    'terminal'
  ]) {
    fake.query = query
    await act(async () => view.rerender(<TerminalPane {...props} />))
    expect(screen.getByRole('button', { name: 'Refresh sessions' })).toBeTruthy()
  }
  expect(fake.listSessions).toHaveBeenCalledTimes(1)
  expect(fake.attribution).toHaveBeenCalledTimes(1)
})

it('refreshes explicitly, reloads genuinely hidden sections, and removes focus listeners', async () => {
  const props = paneProps()
  const view = render(<TerminalPane {...props} />)
  await act(async () => {})
  fireEvent.click(screen.getByRole('button', { name: 'Refresh sessions' }))
  await act(async () => {})
  expect(fake.listSessions).toHaveBeenCalledTimes(2)
  expect(fake.attribution).toHaveBeenCalledTimes(1)

  fake.query = 'GPU Acceleration'
  await act(async () => view.rerender(<TerminalPane {...props} />))
  expect(screen.queryByRole('button', { name: 'Refresh sessions' })).toBeNull()
  await act(async () => window.dispatchEvent(new Event('focus')))
  expect(fake.attribution).toHaveBeenCalledTimes(1)

  fake.query = 'manage'
  await act(async () => view.rerender(<TerminalPane {...props} />))
  expect(screen.getByRole('button', { name: 'Refresh sessions' })).toBeTruthy()
  expect(fake.listSessions).toHaveBeenCalledTimes(3)
  expect(fake.attribution).toHaveBeenCalledTimes(2)
  await act(async () => window.dispatchEvent(new Event('focus')))
  expect(fake.attribution).toHaveBeenCalledTimes(3)

  view.unmount()
  await act(async () => window.dispatchEvent(new Event('focus')))
  expect(fake.attribution).toHaveBeenCalledTimes(3)
})

it('preserves an uncommitted scrollback draft while its section remains visible', async () => {
  const props = { ...paneProps(), scrollbackMode: 'custom' as const }
  const view = render(<TerminalPane {...props} />)
  await act(async () => {})
  fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '12345' } })
  expect(props.updateSettings).not.toHaveBeenCalled()

  fake.query = 'scrollback'
  await act(async () => view.rerender(<TerminalPane {...props} />))
  const input = screen.getByRole('spinbutton')
  expect(input.getAttribute('value')).toBe('12345')
  fireEvent.blur(input)
  expect(props.updateSettings).toHaveBeenCalledWith({ terminalScrollbackRows: 12345 })
})

it('retains a pending action target only while its section remains visible', async () => {
  const props = paneProps()
  const view = render(<TerminalPane {...props} />)
  await act(async () => {})
  fireEvent.click(screen.getByRole('button', { name: 'Preview session action' }))
  fake.query = 'manage'
  await act(async () => view.rerender(<TerminalPane {...props} />))
  expect(screen.getByText('Pending action for synthetic-session')).toBeTruthy()

  fake.query = 'GPU Acceleration'
  await act(async () => view.rerender(<TerminalPane {...props} />))
  expect(screen.queryByText('Pending action for synthetic-session')).toBeNull()
  fake.query = 'manage'
  await act(async () => view.rerender(<TerminalPane {...props} />))
  expect(screen.queryByText('Pending action for synthetic-session')).toBeNull()
})
