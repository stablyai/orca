// PAIRED-WAKE-TYPE-THROUGH: held typing goes in only once the pane is attached to the woken terminal.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isAttachedForWakeInput, type WakeInputTransport } from './wake-input-attached'
import {
  beginWorkspaceWake,
  captureWakeInput,
  endWorkspaceWake,
  pumpWakeInputForTests,
  resetWakeInputForTests
} from '../../input/wake-input-buffer'

const WAKE_STARTED_AT = 1_800_000_000_000

function transport(overrides: Partial<WakeInputTransport> = {}): WakeInputTransport {
  return {
    isConnected: () => true,
    getPtyId: () => 'remote:env@@pty-2',
    getRecoveryState: () => ({ phase: 'connected' }),
    isConnectPending: () => false,
    hasUndeliveredInput: () => false,
    ...overrides
  }
}

describe('isAttachedForWakeInput', () => {
  it('is attached when connected with a PTY, nothing pending and nothing unsent', () => {
    expect(isAttachedForWakeInput(transport())).toBe(true)
  })

  it('is not attached before the woken PTY is (connected, but no PTY yet)', () => {
    expect(isAttachedForWakeInput(transport({ getPtyId: () => null }))).toBe(false)
  })

  it('is not attached while the connect is pending, recovering, unsent or disconnected', () => {
    expect(isAttachedForWakeInput(transport({ isConnectPending: () => true }))).toBe(false)
    expect(
      isAttachedForWakeInput(transport({ getRecoveryState: () => ({ phase: 'reconnecting' }) }))
    ).toBe(false)
    expect(isAttachedForWakeInput(transport({ hasUndeliveredInput: () => true }))).toBe(false)
    expect(isAttachedForWakeInput(transport({ isConnected: () => false }))).toBe(false)
    expect(isAttachedForWakeInput(null)).toBe(false)
  })
})

describe('held typing across a paired wake', () => {
  afterEach(() => {
    resetWakeInputForTests()
    vi.useRealTimers()
  })

  it('delivers every held key, once, only after the woken PTY attaches', () => {
    const delivered: string[] = []
    let ptyId: string | null = null
    let connected = false
    const pane = transport({ isConnected: () => connected, getPtyId: () => ptyId })
    const ready = (): boolean => isAttachedForWakeInput(pane)
    vi.useFakeTimers()
    vi.setSystemTime(WAKE_STARTED_AT)
    beginWorkspaceWake('ws', WAKE_STARTED_AT)
    for (const key of 'git status') {
      expect(captureWakeInput('ws', 'leaf', key, (data) => delivered.push(data), ready)).toBe(true)
    }
    pumpWakeInputForTests()
    endWorkspaceWake('ws', 'ready')
    // Connected again, but the woken PTY is not attached yet: nothing goes in.
    connected = true
    pumpWakeInputForTests()
    expect(delivered).toEqual([])
    ptyId = 'remote:env@@pty-2'
    pumpWakeInputForTests()
    expect(delivered).toEqual(['git status'])
    pumpWakeInputForTests()
    expect(delivered).toEqual(['git status'])
  })
})

vi.mock('@/lib/window-activity/window-visibility-interval', () => ({
  installWindowVisibilityInterval: () => () => undefined
}))
