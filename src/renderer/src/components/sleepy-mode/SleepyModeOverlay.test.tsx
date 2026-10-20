// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import SleepyModeOverlay from './SleepyModeOverlay'

type SleepyStoreState = {
  sleepyModeActive: boolean
  setSleepyModeActive: (active: boolean) => void
  settings: { sleepyModeIdleMinutes: number }
  agentStatusByPaneKey: Record<string, AgentStatusEntry>
  agentStatusEpoch: number
  retainedAgentsByPaneKey: Record<string, unknown>
  petVisible: boolean
  petId: string
  customPets: never[]
}

const storeMocks = vi.hoisted(() => ({
  state: {
    sleepyModeActive: false,
    setSleepyModeActive: vi.fn(),
    settings: { sleepyModeIdleMinutes: 0 },
    agentStatusByPaneKey: {},
    agentStatusEpoch: 0,
    retainedAgentsByPaneKey: {},
    petVisible: true,
    petId: 'claude-the-mage',
    customPets: []
  }
}))

vi.mock('../../store', () => ({
  useAppStore: (selector: (state: SleepyStoreState) => unknown) => selector(storeMocks.state)
}))

vi.mock('@/hooks/usePrefersReducedMotion', () => ({
  usePrefersReducedMotion: () => true
}))

vi.mock('@/lib/agent-status-epoch-clock', () => ({
  getAgentStatusEpochNow: () => 1_000
}))

/** Seconds the fake OS clock reports; the hook polls this instead of listening for DOM events. */
let systemIdleSeconds: number | null = 0

function entry(paneKey: string, state: AgentStatusEntry['state']): AgentStatusEntry {
  return { state, prompt: '', updatedAt: 1_000, stateStartedAt: 1_000, paneKey, stateHistory: [] }
}

function setState(next: Partial<SleepyStoreState>): void {
  Object.assign(storeMocks.state, next)
}

describe('SleepyModeOverlay', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    systemIdleSeconds = 0
    setState({
      sleepyModeActive: false,
      setSleepyModeActive: vi.fn(),
      settings: { sleepyModeIdleMinutes: 0 },
      agentStatusByPaneKey: {}
    })
    Object.defineProperty(window, 'api', {
      configurable: true,
      writable: true,
      value: {
        agentAwake: {
          getSystemIdleSeconds: vi.fn(async () => systemIdleSeconds)
        }
      }
    })
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('renders nothing until it is active', () => {
    render(<SleepyModeOverlay />)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('starts once the OS reports the configured idle delay, and not before', async () => {
    setState({ settings: { sleepyModeIdleMinutes: 5 } })
    render(<SleepyModeOverlay />)

    systemIdleSeconds = 299
    await vi.advanceTimersByTimeAsync(30_000)
    expect(storeMocks.state.setSleepyModeActive).not.toHaveBeenCalled()

    systemIdleSeconds = 300
    await vi.advanceTimersByTimeAsync(15_000)
    expect(storeMocks.state.setSleepyModeActive).toHaveBeenCalledWith(true)
  })

  it('does not start when auto-start is off', async () => {
    systemIdleSeconds = 10_000
    render(<SleepyModeOverlay />)
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    expect(storeMocks.state.setSleepyModeActive).not.toHaveBeenCalled()
  })

  it('never starts when the platform cannot report idle time', async () => {
    setState({ settings: { sleepyModeIdleMinutes: 5 } })
    systemIdleSeconds = null
    render(<SleepyModeOverlay />)

    await vi.advanceTimersByTimeAsync(60 * 60_000)
    expect(storeMocks.state.setSleepyModeActive).not.toHaveBeenCalled()
  })

  it('keeps waiting while work in a terminal or browser pane keeps the OS clock low', async () => {
    setState({ settings: { sleepyModeIdleMinutes: 5 } })
    render(<SleepyModeOverlay />)

    for (let minute = 0; minute < 20; minute += 1) {
      systemIdleSeconds = 4
      await vi.advanceTimersByTimeAsync(60_000)
    }
    expect(storeMocks.state.setSleepyModeActive).not.toHaveBeenCalled()
  })

  it('shows the live fleet and wakes on a keypress', () => {
    setState({
      sleepyModeActive: true,
      agentStatusByPaneKey: { a: entry('a', 'working'), b: entry('b', 'waiting') }
    })
    render(<SleepyModeOverlay />)

    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getByText('1 working · 1 waiting')).toBeTruthy()

    fireEvent.keyDown(window, { key: 'a' })
    expect(storeMocks.state.setSleepyModeActive).toHaveBeenCalledWith(false)
  })

  // Why dispatch at a real element: an event dispatched on `window` never travels through the
  // workspace, so a listener below it could not fire either way and the assertion would be empty.
  const wakeEvents: { name: string; build: () => Event }[] = [
    {
      name: 'keydown',
      build: () => new KeyboardEvent('keydown', { key: 'Enter', cancelable: true, bubbles: true })
    },
    {
      name: 'pointerdown',
      build: () => new MouseEvent('pointerdown', { cancelable: true, bubbles: true })
    },
    { name: 'wheel', build: () => new WheelEvent('wheel', { cancelable: true, bubbles: true }) }
  ]

  it.each(wakeEvents)('wakes on $name and never lets it reach the workspace', ({ name, build }) => {
    setState({ sleepyModeActive: true })
    render(<SleepyModeOverlay />)

    const workspace = document.createElement('input')
    document.body.append(workspace)
    const reachedWorkspace = vi.fn()
    workspace.addEventListener(name, reachedWorkspace)

    const event = build()
    workspace.dispatchEvent(event)

    expect(storeMocks.state.setSleepyModeActive).toHaveBeenCalledWith(false)
    expect(event.defaultPrevented).toBe(true)
    expect(reachedWorkspace).not.toHaveBeenCalled()
    workspace.remove()
  })
})
