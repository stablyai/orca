// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UseBoundStore, StoreApi } from 'zustand'
import type { TerminalUsageLimitOverlay } from './TerminalUsageLimitOverlay'
import type { AgentStatusEntry } from '../../../../shared/agent-status/contracts/agent-status-types'
import type { TerminalUsageLimitContinuationResult } from '../../../../shared/terminal-usage-limit-continuation'
import { toRuntimeExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { TooltipProvider } from '@/components/ui/tooltip'
import {
  PaneUsageLimitNotice,
  TerminalPaneUsageLimitPortals
} from './TerminalPaneUsageLimitPortals'
import { terminalUsageLimitNotice } from './terminal-usage-limit-notice'
import type { TerminalPaneController } from './use-terminal-pane-controller'

type State = {
  agentStatusByPaneKey: Record<string, AgentStatusEntry>
  unrelated: number
  activeWorktreeId?: string
  activeWorkspaceExecutionHostId?: ExecutionHostId
}
type Mocks = {
  call: ReturnType<
    typeof vi.fn<(...args: unknown[]) => Promise<TerminalUsageLimitContinuationResult>>
  >
  capability: 'supported' | 'unknown' | 'unsupported'
  target: RuntimeClientTarget | null
  renders: number
  locale: string
  mobile: boolean
}
const mocks = vi.hoisted((): Mocks => ({
  call: vi.fn<(...args: unknown[]) => Promise<TerminalUsageLimitContinuationResult>>(),
  capability: 'supported',
  target: { kind: 'local' },
  renders: 0,
  locale: 'en',
  mobile: false
}))
vi.mock('@/lib/pane-manager/mobile-driver-state', () => ({
  getDriverForPty: () => ({ kind: mocks.mobile ? 'mobile' : 'idle' })
}))
vi.mock('@/store', async () => {
  const { create } = await import('zustand')
  return { useAppStore: create<State>(() => ({ agentStatusByPaneKey: {}, unrelated: 0 })) }
})
vi.mock('@/runtime/use-worktree-runtime-target', () => ({
  useWorktreeRuntimeTarget: () => mocks.target
}))
vi.mock('@/runtime/structured-agent-session-host-capability', () => ({
  useStructuredAgentSessionHostCapabilityState: () => mocks.capability
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: (...args: unknown[]) => mocks.call(...args)
}))
vi.mock('@/lib/agent-session/launch/structured-agent-session-launch-label', () => ({
  structuredAgentLabel: (agent: string) => (agent === 'claude' ? 'Claude' : 'Codex')
}))
vi.mock('./TerminalUsageLimitOverlay', async (original) => {
  const actual = await original<{ TerminalUsageLimitOverlay: typeof TerminalUsageLimitOverlay }>()
  return {
    TerminalUsageLimitOverlay: (props: Parameters<typeof actual.TerminalUsageLimitOverlay>[0]) => {
      mocks.renders += 1
      return <actual.TerminalUsageLimitOverlay {...props} />
    }
  }
})
vi.mock('@/i18n/i18n', () => ({
  getIntlLocale: () => mocks.locale,
  translate: (key: string, fallback: string, values: Record<string, string> = {}) => {
    const german: Record<string, string> = {
      'components.native-chat.failureWords.usageLimitReachedNamed':
        '{{agent}} hat das Nutzungslimit für {{window}} erreicht.',
      'components.native-chat.failureWords.usageLimitWindowWeekly': 'die aktuelle Woche',
      'terminal.usageLimit.continue': 'Jetzt fortsetzen',
      'terminal.usageLimit.explanation':
        'Sende „continue“ an {{agent}}, um die unterbrochene Unterhaltung erneut fortzusetzen.'
    }
    return (mocks.locale === 'de' ? (german[key] ?? fallback) : fallback).replace(
      /\{\{(\w+)\}\}/g,
      (_match, name: string) => values[name] ?? ''
    )
  }
}))

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture store supplies exactly the selector fields the production component reads.
const store = (await import('@/store')).useAppStore as unknown as UseBoundStore<StoreApi<State>>
const LEAF = '11111111-1111-4111-8111-111111111111'
const PANE = `tab:${LEAF}`
function row(agent: 'claude' | 'codex' = 'claude'): AgentStatusEntry {
  return {
    state: 'done',
    stateStartedAt: 20,
    updatedAt: 20,
    prompt: 'work',
    paneKey: PANE,
    stateHistory: [],
    agentType: agent,
    terminalHandle: 'term_owned',
    providerSession: { id: 'session', key: 'session_id' },
    turnEndedAt: 20,
    turnEndDisposition: 'identified',
    mainAgent: {
      state: 'done',
      outcome: 'failure',
      stateStartedAt: 20,
      usageLimit: { window: 'weekly', resetsAt: 1793760846000 }
    }
  }
}
function setRow(next: AgentStatusEntry | undefined): void {
  act(() => store.setState({ agentStatusByPaneKey: next ? { [PANE]: next } : {} }))
}
function mount(target: RuntimeClientTarget = { kind: 'local' }) {
  return render(
    <TooltipProvider>
      <PaneUsageLimitNotice paneKey={PANE} target={target} />
    </TooltipProvider>
  )
}
const button = () => screen.getByRole('button', { name: 'Continue now' })

beforeEach(() => {
  mocks.call.mockReset().mockResolvedValue({ status: 'turn-started' })
  mocks.capability = 'supported'
  mocks.target = { kind: 'local' }
  mocks.renders = 0
  mocks.locale = 'en'
  mocks.mobile = false
  store.setState({
    agentStatusByPaneKey: { [PANE]: row() },
    unrelated: 0,
    activeWorktreeId: undefined,
    activeWorkspaceExecutionHostId: undefined
  })
})
afterEach(() => {
  cleanup()
  setRow(undefined)
})

describe('terminal usage-limit overlay', () => {
  it('renders the current quota/reset, preserves CLI focus and routes one explicit continuation to its owning host', async () => {
    const input = document.createElement('textarea')
    document.body.append(input)
    input.value = 'my draft'
    input.focus()
    mount({ kind: 'environment', environmentId: 'owner' })
    expect(document.activeElement).toBe(input)
    expect(screen.getByRole('region').textContent).toContain('Claude hit its weekly limit.')
    expect(screen.getByRole('status').textContent).toContain('It resets at')
    expect(mocks.call).not.toHaveBeenCalled()
    await act(async () => fireEvent.click(button()))
    expect(mocks.call).toHaveBeenCalledExactlyOnceWith(
      { kind: 'environment', environmentId: 'owner' },
      'terminal.continueAfterUsageLimit',
      {
        terminal: 'term_owned',
        sessionId: 'session',
        turnEndedAt: 20,
        client: { id: 'orca-desktop', type: 'desktop' }
      }
    )
    expect(input.value).toBe('my draft')
    expect(screen.queryByRole('button', { name: 'Continue now' })).toBeNull()
    input.remove()
  })

  it('disables an in-flight action, ignores its stale result after a new turn, and allows the later Codex cut', async () => {
    let finish: (value: TerminalUsageLimitContinuationResult) => void = () => {}
    mocks.call.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    mount()
    fireEvent.click(button())
    expect(button().hasAttribute('disabled')).toBe(true)
    fireEvent.click(button())
    expect(mocks.call).toHaveBeenCalledOnce()
    setRow({ ...row(), state: 'working', mainAgent: { state: 'working', stateStartedAt: 30 } })
    expect(screen.queryByRole('region')).toBeNull()
    setRow({ ...row('codex'), turnEndedAt: 40 })
    await act(async () => finish({ status: 'unknown' }))
    expect(screen.getByRole('status').textContent).toContain('Send “continue” to Codex')
    expect(button().hasAttribute('disabled')).toBe(false)
  })

  it.each([
    [{ status: 'refused', reason: 'draft' }, 'already has a draft', true],
    [{ status: 'refused', reason: 'permission' }, 'waiting for a choice', true],
    [{ status: 'refused', reason: 'changed' }, 'turn changed', true],
    [{ status: 'draft' }, 'Review and send it in the terminal', false],
    [{ status: 'unknown' }, 'Check the terminal before trying again', false]
  ] as const)('reports %j truthfully without replay', async (result, words, retry) => {
    mocks.call.mockResolvedValueOnce(result)
    mount()
    await act(async () => fireEvent.click(button()))
    expect(screen.getByRole('status').textContent).toContain(words)
    expect(screen.queryByRole('button', { name: 'Continue now' }) !== null).toBe(retry)
    expect(mocks.call).toHaveBeenCalledOnce()
  })

  it('does not offer replay when the RPC reply is lost, and re-keys results when the host changes', async () => {
    mocks.call.mockRejectedValueOnce(new Error('raw transport detail'))
    const view = mount()
    await act(async () => fireEvent.click(button()))
    expect(screen.getByRole('status').textContent).toContain(
      'Couldn’t confirm whether Claude received'
    )
    expect(screen.queryByText('raw transport detail')).toBeNull()
    view.rerender(
      <TooltipProvider>
        <PaneUsageLimitNotice
          paneKey={PANE}
          target={{ kind: 'environment', environmentId: 'new-owner' }}
        />
      </TooltipProvider>
    )
    expect(button().hasAttribute('disabled')).toBe(false)
  })

  it('keeps unknown-host controls disabled and older hosts on ordinary terminal input', () => {
    mocks.capability = 'unknown'
    const view = mount()
    expect(button().hasAttribute('disabled')).toBe(true)
    mocks.capability = 'unsupported'
    view.rerender(
      <TooltipProvider>
        <PaneUsageLimitNotice paneKey={PANE} target={{ kind: 'local' }} />
      </TooltipProvider>
    )
    expect(screen.queryByRole('button', { name: 'Continue now' })).toBeNull()
    expect(screen.getByRole('status').textContent).toContain('Send a message in the terminal')
  })

  it('minimizes inside the pane and renders a representative translated long notice', () => {
    mocks.locale = 'de'
    mount()
    expect(screen.getByRole('region').textContent).toContain('die aktuelle Woche')
    expect(screen.getByRole('status').textContent).toContain('unterbrochene Unterhaltung')
    expect(screen.getByRole('button', { name: 'Jetzt fortsetzen' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Minimize' }))
    expect(screen.queryByRole('region')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Claude hat das Nutzungslimit/ }))
    expect(screen.getByRole('region')).toBeTruthy()
  })

  it('removes the notice when stopped, restored, ended, structured, child-held or replaced', () => {
    mount()
    const initial = row()
    const cases: AgentStatusEntry[] = [
      { ...initial, interrupted: true },
      { ...initial, restoredUnconfirmed: true },
      { ...initial, sessionBoundary: true },
      { ...initial, structuredHostOwned: true },
      { ...initial, state: 'working' },
      { ...initial, turnEndDisposition: 'ambiguous' },
      { ...initial, mainAgent: { state: 'done', stateStartedAt: 20, outcome: 'success' } }
    ]
    for (const next of cases) {
      setRow(next)
      expect(screen.queryByRole('region')).toBeNull()
    }
    setRow(undefined)
    expect(terminalUsageLimitNotice(undefined)).toBeNull()
  })

  it.each([10, 100])(
    'does not rerender notices for unrelated or unused state at %i panes',
    (count) => {
      const rows = Object.fromEntries(
        Array.from({ length: count }, (_, i) => [`pane-${i}`, { ...row(), paneKey: `pane-${i}` }])
      )
      store.setState({ agentStatusByPaneKey: rows })
      render(
        <TooltipProvider>
          {Object.keys(rows).map((paneKey) => (
            <PaneUsageLimitNotice key={paneKey} paneKey={paneKey} target={{ kind: 'local' }} />
          ))}
        </TooltipProvider>
      )
      mocks.renders = 0
      act(() => store.setState({ unrelated: 1 }))
      act(() =>
        store.setState({
          agentStatusByPaneKey: {
            ...rows,
            'pane-0': { ...rows['pane-0'], updatedAt: 99, prompt: 'unused' }
          }
        })
      )
      expect(mocks.renders).toBe(0)
      act(() =>
        store.setState({
          agentStatusByPaneKey: {
            ...rows,
            'pane-0': {
              ...rows['pane-0'],
              mainAgent: { state: 'done', outcome: 'failure', stateStartedAt: 20, usageLimit: {} }
            }
          }
        })
      )
      expect(mocks.renders).toBe(1)
    }
  )

  it('retains uncertain results through temporary pane suppression and retires them on closure', async () => {
    mocks.call.mockRejectedValueOnce(new Error('lost reply'))
    const pane = document.createElement('div')
    document.body.append(pane)
    const controller = paneController(pane)
    const view = renderPortals(controller)
    await act(async () => fireEvent.click(button()))
    for (const suppressed of [
      { ...controller, isVisible: false },
      { ...controller, showSshReconnectOverlay: true },
      { ...controller, effectiveChatViewMode: true, chatLeafId: LEAF },
      controller
    ]) {
      mocks.mobile = suppressed === controller
      view.rerender(portals(suppressed))
      expect(screen.queryByRole('region')).toBeNull()
      mocks.mobile = false
      view.rerender(portals(controller))
      expect(screen.getByRole('status').textContent).toContain('Couldn’t confirm whether')
      expect(screen.queryByRole('button', { name: 'Continue now' })).toBeNull()
    }
    view.rerender(
      portals({
        ...controller,
        paneProcessExitsByPaneId: {
          1: { paneId: 1, exitCode: 0, reason: 'process-failed', startup: null }
        }
      })
    )
    setRow(undefined)
    setRow(row())
    view.rerender(portals(controller))
    expect(button().hasAttribute('disabled')).toBe(false)
    pane.remove()
  })

  it('settles a pending action while hidden without reviving it and resets only for a new cut', async () => {
    let finish: (value: TerminalUsageLimitContinuationResult) => void = () => {}
    mocks.call.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const pane = document.createElement('div')
    document.body.append(pane)
    const controller = paneController(pane)
    const view = renderPortals(controller)
    fireEvent.click(button())
    view.rerender(portals({ ...controller, isVisible: false }))
    expect(screen.queryByRole('region')).toBeNull()
    view.rerender(portals(controller))
    expect(button().hasAttribute('disabled')).toBe(true)
    view.rerender(portals({ ...controller, isVisible: false }))
    await act(async () => finish({ status: 'unknown' }))
    view.rerender(portals(controller))
    expect(screen.queryByRole('button', { name: 'Continue now' })).toBeNull()
    setRow({ ...row(), turnEndedAt: 40 })
    expect(button().hasAttribute('disabled')).toBe(false)
    expect(mocks.call).toHaveBeenCalledOnce()
    pane.remove()
  })

  it('retains an uncertain send through a full pane remount while source facts remain the same', async () => {
    mocks.call.mockResolvedValueOnce({ status: 'input-accepted' })
    const view = mount()
    await act(async () => fireEvent.click(button()))
    view.unmount()
    const remounted = mount()
    expect(screen.queryByRole('button', { name: 'Continue now' })).toBeNull()
    expect(screen.getByRole('status').textContent).toContain('Continue was sent')
    remounted.unmount()
    setRow({ ...row(), interrupted: true })
    setRow(row())
    mount()
    expect(button().hasAttribute('disabled')).toBe(false)
    expect(mocks.call).toHaveBeenCalledOnce()
  })

  it('keeps the attempt while children hide its end and through an atomic source pane transfer', async () => {
    mocks.call.mockResolvedValueOnce({ status: 'unknown' })
    const view = mount()
    await act(async () => fireEvent.click(button()))
    view.unmount()
    setRow({ ...row(), state: 'working', turnEndedAt: undefined, turnEndDisposition: undefined })
    setRow(row())
    const restored = mount()
    expect(screen.queryByRole('button', { name: 'Continue now' })).toBeNull()
    restored.unmount()
    const { createTestStore } = await import('@/store/slices/store-test-helpers')
    const authority = createTestStore()
    authority.setState({ agentStatusByPaneKey: { [PANE]: row() } })
    const destination = `detached:${LEAF}`
    authority
      .getState()
      .transferAgentPaneAuthority({ fromPaneKey: PANE, toPaneKey: destination, ptyId: 'pty-owned' })
    act(() => store.setState({ agentStatusByPaneKey: authority.getState().agentStatusByPaneKey }))
    render(
      <TooltipProvider>
        <PaneUsageLimitNotice paneKey={destination} target={{ kind: 'local' }} />
      </TooltipProvider>
    )
    expect(screen.queryByRole('button', { name: 'Continue now' })).toBeNull()
    expect(screen.getByRole('status').textContent).toContain('Couldn’t confirm whether')
    expect(mocks.call).toHaveBeenCalledOnce()
  })

  it.each([10, 100])(
    'bounds attempted-result retirement work and updates only its owner at %i panes',
    async (count) => {
      const rows = Object.fromEntries(
        Array.from({ length: count }, (_, i) => [
          `pane-${i}`,
          {
            ...row(),
            paneKey: `pane-${i}`,
            terminalHandle: `term-${i}`,
            providerSession: { id: `session-${i}`, key: 'session_id' as const }
          }
        ])
      )
      store.setState({ agentStatusByPaneKey: rows })
      mocks.call.mockResolvedValue({ status: 'unknown' })
      render(
        <TooltipProvider>
          {Object.keys(rows).map((paneKey) => (
            <PaneUsageLimitNotice key={paneKey} paneKey={paneKey} target={{ kind: 'local' }} />
          ))}
        </TooltipProvider>
      )
      for (const action of screen.getAllByRole('button', { name: 'Continue now' })) {
        await act(async () => fireEvent.click(action))
      }
      expect(mocks.call).toHaveBeenCalledTimes(count)
      mocks.renders = 0
      act(() => store.setState({ unrelated: 1 }))
      expect(mocks.renders).toBe(0)
      let walks = 0
      const observed = new Proxy(rows, {
        ownKeys: () => {
          walks++
          return Object.keys(rows)
        }
      })
      act(() => store.setState({ agentStatusByPaneKey: observed }))
      expect(walks).toBe(1)
      expect(mocks.renders).toBe(0)
      act(() => store.setState({ unrelated: 2 }))
      expect(walks).toBe(1)
      expect(mocks.renders).toBe(0)
      act(() =>
        store.setState({
          agentStatusByPaneKey: { ...rows, 'pane-0': { ...rows['pane-0'], turnEndedAt: 40 } }
        })
      )
      expect(mocks.renders).toBe(1)
      expect(screen.getAllByRole('button', { name: 'Continue now' })).toHaveLength(1)
      expect(mocks.call).toHaveBeenCalledTimes(count)
    }
  )

  it('settles while fully unmounted and retires even an unmounted attempt on an owning-host change', async () => {
    let finish: (value: TerminalUsageLimitContinuationResult) => void = () => {}
    mocks.call.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const pane = document.createElement('div')
    document.body.append(pane)
    const controller = paneController(pane)
    const view = renderPortals(controller)
    fireEvent.click(button())
    view.unmount()
    await act(async () => finish({ status: 'unknown' }))
    const remounted = renderPortals(controller)
    expect(screen.queryByRole('button', { name: 'Continue now' })).toBeNull()
    remounted.unmount()
    act(() =>
      store.setState({
        activeWorktreeId: controller.worktreeId,
        activeWorkspaceExecutionHostId: toRuntimeExecutionHostId('replacement')
      })
    )
    act(() => store.setState({ activeWorkspaceExecutionHostId: 'local' }))
    renderPortals(controller)
    expect(button().hasAttribute('disabled')).toBe(false)
    expect(mocks.call).toHaveBeenCalledOnce()
    pane.remove()
  })

  it('portals only to terminal panes and suppresses a closed process or reconnecting host', () => {
    const pane = document.createElement('div')
    document.body.append(pane)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these are all controller fields read by the portal under test.
    const controller = {
      worktreeId: 'folder-workspace',
      tabId: 'tab',
      isVisible: true,
      showSshReconnectOverlay: false,
      managedPanes: [{ id: 1, leafId: LEAF, container: pane }],
      paneProcessExitsByPaneId: {},
      paneTransportsRef: { current: new Map([[1, { getPtyId: () => 'pty-owned' }]]) },
      effectiveChatViewMode: false,
      chatLeafId: null
    } as unknown as TerminalPaneController
    const view = render(
      <TooltipProvider>
        <TerminalPaneUsageLimitPortals controller={controller} />
      </TooltipProvider>
    )
    expect(pane.querySelector('.terminal-usage-limit-overlay')).not.toBeNull()
    for (const next of [
      { ...controller, effectiveChatViewMode: true, chatLeafId: LEAF },
      { ...controller, showSshReconnectOverlay: true },
      {
        ...controller,
        paneProcessExitsByPaneId: {
          1: { paneId: 1, exitCode: 0, reason: 'process-failed' as const, startup: null }
        }
      }
    ]) {
      view.rerender(
        <TooltipProvider>
          <TerminalPaneUsageLimitPortals controller={next} />
        </TooltipProvider>
      )
      expect(pane.querySelector('.terminal-usage-limit-overlay')).toBeNull()
    }
    pane.remove()
  })
})

function paneController(pane: HTMLElement): TerminalPaneController {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture supplies every controller field read by the production portal.
  return {
    worktreeId: 'folder-workspace',
    tabId: 'tab',
    isVisible: true,
    showSshReconnectOverlay: false,
    managedPanes: [{ id: 1, leafId: LEAF, container: pane }],
    paneProcessExitsByPaneId: {},
    paneTransportsRef: { current: new Map([[1, { getPtyId: () => 'pty-owned' }]]) },
    effectiveChatViewMode: false,
    chatLeafId: null
  } as unknown as TerminalPaneController
}
function portals(controller: TerminalPaneController) {
  return (
    <TooltipProvider>
      <TerminalPaneUsageLimitPortals controller={controller} />
    </TooltipProvider>
  )
}
function renderPortals(controller: TerminalPaneController) {
  return render(portals(controller))
}
