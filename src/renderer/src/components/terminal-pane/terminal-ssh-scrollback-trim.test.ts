import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import {
  SSH_HIDDEN_SCROLLBACK_TRIM_ROWS,
  trimHiddenSshScrollback,
  restoreHiddenSshScrollback,
  useHiddenSshScrollbackTrim
} from './terminal-ssh-scrollback-trim'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePane(id: number, scrollback = 5000) {
  return { id, terminal: { options: { scrollback } } }
}

function makeSshTransport(id: number) {
  return { getPtyId: (): string | null => `ssh:ssh-conn-${id}@@pty-${id}` }
}

function makeLocalTransport(id: number) {
  return { getPtyId: (): string | null => `wt-${id}@@session-${id}` }
}

function makeNullTransport() {
  return { getPtyId: (): string | null => null }
}

// ---------------------------------------------------------------------------
// trimHiddenSshScrollback
// ---------------------------------------------------------------------------

describe('trimHiddenSshScrollback', () => {
  it('trims SSH panes to trimRows', () => {
    const pane = makePane(1, 5000)
    const manager = { getPanes: () => [pane] }
    const transports = new Map([[1, makeSshTransport(1)]])
    trimHiddenSshScrollback(manager, transports, SSH_HIDDEN_SCROLLBACK_TRIM_ROWS)
    expect(pane.terminal.options.scrollback).toBe(SSH_HIDDEN_SCROLLBACK_TRIM_ROWS)
  })

  it('does not touch local (non-SSH) panes', () => {
    const pane = makePane(2, 5000)
    const manager = { getPanes: () => [pane] }
    const transports = new Map([[2, makeLocalTransport(2)]])
    trimHiddenSshScrollback(manager, transports, SSH_HIDDEN_SCROLLBACK_TRIM_ROWS)
    expect(pane.terminal.options.scrollback).toBe(5000)
  })

  it('does not touch panes with no transport entry', () => {
    const pane = makePane(3, 5000)
    const manager = { getPanes: () => [pane] }
    const transports = new Map<number, ReturnType<typeof makeSshTransport>>()
    trimHiddenSshScrollback(manager, transports, 200)
    expect(pane.terminal.options.scrollback).toBe(5000)
  })

  it('does not touch panes whose transport returns null pty id', () => {
    const pane = makePane(4, 5000)
    const manager = { getPanes: () => [pane] }
    const transports = new Map([[4, makeNullTransport()]])
    trimHiddenSshScrollback(manager, transports, 200)
    expect(pane.terminal.options.scrollback).toBe(5000)
  })

  it('trims only SSH panes in a mixed-type set', () => {
    const sshPane = makePane(1, 5000)
    const localPane = makePane(2, 5000)
    const manager = { getPanes: () => [sshPane, localPane] }
    const transports = new Map([
      [1, makeSshTransport(1)],
      [2, makeLocalTransport(2)]
    ])
    trimHiddenSshScrollback(manager, transports, 200)
    expect(sshPane.terminal.options.scrollback).toBe(200)
    expect(localPane.terminal.options.scrollback).toBe(5000)
  })
})

// ---------------------------------------------------------------------------
// restoreHiddenSshScrollback
// ---------------------------------------------------------------------------

describe('restoreHiddenSshScrollback', () => {
  it('restores a trimmed SSH pane back to configuredRows', () => {
    const pane = makePane(1, SSH_HIDDEN_SCROLLBACK_TRIM_ROWS)
    const manager = { getPanes: () => [pane] }
    const transports = new Map([[1, makeSshTransport(1)]])
    restoreHiddenSshScrollback(manager, transports, 5000)
    expect(pane.terminal.options.scrollback).toBe(5000)
  })

  it('does not reduce a pane already at or above configuredRows', () => {
    const pane = makePane(1, 5000)
    const manager = { getPanes: () => [pane] }
    const transports = new Map([[1, makeSshTransport(1)]])
    restoreHiddenSshScrollback(manager, transports, 1000)
    expect(pane.terminal.options.scrollback).toBe(5000)
  })

  it('does not restore non-SSH panes', () => {
    const pane = makePane(2, 100)
    const manager = { getPanes: () => [pane] }
    const transports = new Map([[2, makeLocalTransport(2)]])
    restoreHiddenSshScrollback(manager, transports, 5000)
    expect(pane.terminal.options.scrollback).toBe(100)
  })
})

// ---------------------------------------------------------------------------
// useHiddenSshScrollbackTrim hook
// ---------------------------------------------------------------------------

describe('useHiddenSshScrollbackTrim', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  function setup(
    isVisible: boolean,
    configuredScrollbackRows = 5000,
    coldParkDelayMs = 30_000
  ) {
    const pane = makePane(1, configuredScrollbackRows)
    const manager = { getPanes: () => [pane] }
    const transports = new Map([[1, makeSshTransport(1)]])
    const managerRef = { current: manager }
    const paneTransportsRef = { current: transports }

    const hook = renderHook(
      (props: { isVisible: boolean; configuredScrollbackRows: number }) =>
        useHiddenSshScrollbackTrim({
          managerRef,
          paneTransportsRef,
          isVisible: props.isVisible,
          configuredScrollbackRows: props.configuredScrollbackRows,
          coldParkDelayMs
        }),
      { initialProps: { isVisible, configuredScrollbackRows } }
    )

    return { hook, pane, managerRef, paneTransportsRef }
  }

  it('does not trim while visible', () => {
    const { pane } = setup(true)
    act(() => vi.advanceTimersByTime(60_000))
    expect(pane.terminal.options.scrollback).toBe(5000)
  })

  it('trims SSH panes after the cold-park delay when hidden', () => {
    const { pane } = setup(false, 5000, 30_000)
    expect(pane.terminal.options.scrollback).toBe(5000)
    act(() => vi.advanceTimersByTime(30_000))
    expect(pane.terminal.options.scrollback).toBe(SSH_HIDDEN_SCROLLBACK_TRIM_ROWS)
  })

  it('does not trim before the cold-park delay elapses', () => {
    const { pane } = setup(false, 5000, 30_000)
    act(() => vi.advanceTimersByTime(29_999))
    expect(pane.terminal.options.scrollback).toBe(5000)
  })

  it('cancels pending trim and restores on re-reveal before timer fires', () => {
    const { hook, pane } = setup(false, 5000, 30_000)
    act(() => vi.advanceTimersByTime(15_000))
    expect(pane.terminal.options.scrollback).toBe(5000)
    // re-reveal before timer fires
    act(() => hook.rerender({ isVisible: true, configuredScrollbackRows: 5000 }))
    act(() => vi.advanceTimersByTime(30_000))
    // timer was cancelled; pane should NOT be trimmed
    expect(pane.terminal.options.scrollback).toBe(5000)
  })

  it('restores scrollback when tab becomes visible after trim', () => {
    const { hook, pane } = setup(false, 5000, 30_000)
    act(() => vi.advanceTimersByTime(30_000))
    expect(pane.terminal.options.scrollback).toBe(SSH_HIDDEN_SCROLLBACK_TRIM_ROWS)
    act(() => hook.rerender({ isVisible: true, configuredScrollbackRows: 5000 }))
    expect(pane.terminal.options.scrollback).toBe(5000)
  })

  it('schedules a new trim when tab is hidden again after restore', () => {
    const { hook, pane } = setup(false, 5000, 30_000)
    // first hide → trim
    act(() => vi.advanceTimersByTime(30_000))
    expect(pane.terminal.options.scrollback).toBe(SSH_HIDDEN_SCROLLBACK_TRIM_ROWS)
    // reveal → restore
    act(() => hook.rerender({ isVisible: true, configuredScrollbackRows: 5000 }))
    expect(pane.terminal.options.scrollback).toBe(5000)
    // hide again → should trim after delay
    act(() => hook.rerender({ isVisible: false, configuredScrollbackRows: 5000 }))
    act(() => vi.advanceTimersByTime(30_000))
    expect(pane.terminal.options.scrollback).toBe(SSH_HIDDEN_SCROLLBACK_TRIM_ROWS)
  })

  it('cancels the pending timer on unmount', () => {
    const { hook, pane } = setup(false, 5000, 30_000)
    act(() => vi.advanceTimersByTime(10_000))
    hook.unmount()
    act(() => vi.advanceTimersByTime(30_000))
    // unmounted: timer should have been cleaned up
    expect(pane.terminal.options.scrollback).toBe(5000)
  })
})
