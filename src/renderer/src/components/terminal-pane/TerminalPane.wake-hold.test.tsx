// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const transport = { connected: false, isConnected: () => transport.connected }
  const container: { current: HTMLDivElement | null } = { current: null }
  return {
    transport,
    container,
    controller: vi.fn(() => ({
      containerRef: container,
      paneTransportsRef: { current: new Map([[1, transport]]) }
    })),
    wakeMachineForHost: vi.fn()
  }
})

vi.mock('./use-terminal-pane-controller', () => ({
  useTerminalPaneController: mocks.controller
}))
vi.mock('./TerminalPaneSurface', () => ({
  TerminalPaneSurface: () => (
    <div data-testid="attached" ref={(node) => void (mocks.container.current = node)}>
      <textarea data-testid="xterm-input" />
    </div>
  )
}))
vi.mock('@/lib/machines/machine-wake-on-open', () => ({
  wakeMachineForHost: mocks.wakeMachineForHost
}))
vi.mock('@/store', async () => {
  const { createTestStore } = await import('@/store/slices/store-test-helpers')
  return { useAppStore: createTestStore() }
})

import { useAppStore } from '@/store'
import TerminalPane from './TerminalPane'
import type { TerminalPaneProps } from './terminal-pane-types'

const WAKE = { machineName: 'box', hostId: 'ssh:box', failure: null }
let root: Root | null = null

function render(): HTMLDivElement {
  const container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  const props: TerminalPaneProps = {
    tabId: 'tab-1',
    worktreeId: 'wt-1',
    isActive: true,
    onPtyExit: () => {},
    onCloseTab: () => {}
  }
  act(() => root?.render(<TerminalPane {...props} />))
  return container
}

function holdState(container: HTMLElement): string | null {
  return (
    container
      .querySelector('[data-terminal-machine-wake-hold]')
      ?.getAttribute('data-terminal-machine-wake-hold') ?? null
  )
}

beforeEach(() => {
  vi.useFakeTimers()
  mocks.transport.connected = false
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.innerHTML = ''
  mocks.controller.mockClear()
  useAppStore.setState({ machineWakeByWorktreeId: {} })
  vi.useRealTimers()
})

describe('TerminalPane machine wake hold', () => {
  it('holds the attach until the wake settles, then keeps the banner until the session is live', () => {
    useAppStore.setState({ machineWakeByWorktreeId: { 'wt-1': WAKE } })
    const container = render()

    expect(mocks.controller).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Waking box…')

    act(() => useAppStore.getState().setWorktreeMachineWake('wt-1', null))

    // Attached once, still covered: keys typed before the reattach lands would be lost.
    expect(container.querySelector('[data-testid="attached"]')).not.toBeNull()
    expect(holdState(container)).toBe('waking')
    const key = new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true })
    container.querySelector('[data-testid="xterm-input"]')?.dispatchEvent(key)
    expect(key.defaultPrevented).toBe(true)

    mocks.transport.connected = true
    act(() => vi.advanceTimersByTime(250))

    expect(holdState(container)).toBeNull()
    const typed = new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true })
    container.querySelector('[data-testid="xterm-input"]')?.dispatchEvent(typed)
    expect(typed.defaultPrevented).toBe(false)
    act(() => useAppStore.getState().setWorktreeMachineWake('wt-1', WAKE))
    // An attached pane keeps its own recovery: a later wake never unmounts or covers it.
    expect(container.querySelector('[data-testid="attached"]')).not.toBeNull()
    expect(holdState(container)).toBeNull()
  })

  it('uncovers a pane that never connects so its own recovery shows', () => {
    useAppStore.setState({ machineWakeByWorktreeId: { 'wt-1': WAKE } })
    const container = render()
    act(() => useAppStore.getState().setWorktreeMachineWake('wt-1', null))
    act(() => vi.advanceTimersByTime(20_200))
    expect(holdState(container)).toBeNull()
  })

  it('shows a failed wake with Retry instead of attaching', () => {
    useAppStore.setState({
      machineWakeByWorktreeId: {
        'wt-1': { ...WAKE, failure: 'The provider didn’t answer in time.' }
      }
    })
    const container = render()

    expect(mocks.controller).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Couldn’t wake box')
    const retry = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Retry')
    act(() => retry?.click())
    expect(mocks.wakeMachineForHost).toHaveBeenCalledWith('ssh:box', 'wt-1')
  })
})
