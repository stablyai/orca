// @vitest-environment happy-dom

import { describe, expect, it, vi } from 'vitest'
import {
  createClaudeModelSwitchConfirmationObserver,
  hasClaudeModelSwitchConfirmation
} from './claude-model-switch-confirmation'

describe('Claude model switch confirmation detection', () => {
  it('recognizes the rendered cache warning across ANSI and wrapped whitespace', () => {
    expect(
      hasClaudeModelSwitchConfirmation(
        '\u001b[1mSwitch model?\u001b[0m\r\nThis\u001b[9Gconversation\u001b[22Gis\u001b[25Gcached\r\nfor the current model.'
      )
    ).toBe(true)
    expect(hasClaudeModelSwitchConfirmation('Set model to Haiku 4.5')).toBe(false)
  })

  it('reports matching success output split across PTY chunks', async () => {
    const dataObserver = { current: (_data: string): void => {} }
    const unsubscribe = vi.fn(() => {})
    const observer = createClaudeModelSwitchConfirmationObserver({
      ptyId: 'pty-1',
      settings: {},
      expectedModelLabel: 'Fable 5',
      subscribeToData: (watcher) => {
        dataObserver.current = watcher
        return unsubscribe
      },
      timeoutMs: 100
    })

    await observer.ready
    dataObserver.current('historical Set model to Fable 5')
    observer.arm()
    dataObserver.current('\u001b[2mSet\u001b[10Gmo')
    dataObserver.current('del\u001b[16Gto\u001b[19GFable 5 and saved as your default\u001b[0m')

    await expect(observer.result).resolves.toBe('applied')
    expect(unsubscribe).toHaveBeenCalledOnce()
  })

  it('accepts the exact cached-history confirmation once and keeps observing', async () => {
    const dataObserver = { current: (_data: string): void => {} }
    const submitConfirmation = vi.fn()
    const observer = createClaudeModelSwitchConfirmationObserver({
      ptyId: 'pty-1',
      settings: {},
      expectedModelLabel: 'Fable 5',
      subscribeToData: (watcher) => {
        dataObserver.current = watcher
        return vi.fn(() => {})
      },
      submitConfirmation,
      timeoutMs: 100
    })

    await observer.ready
    observer.arm()
    dataObserver.current('Switch model? This\u001b[9Gconversation\u001b[22Gis\u001b[25Gcached ')
    dataObserver.current('for\u001b[36Gthe\u001b[40Gcurrent\u001b[48Gmodel.')
    dataObserver.current(' redraw of the same Switch model? prompt')

    expect(submitConfirmation).toHaveBeenCalledOnce()
    dataObserver.current('Set model to Fable 5 and saved as your default for new sessions')

    await expect(observer.result).resolves.toBe('applied')
  })

  it('reports a canceled model switch without opening an interaction', async () => {
    const dataObserver = { current: (_data: string): void => {} }
    const observer = createClaudeModelSwitchConfirmationObserver({
      ptyId: 'pty-1',
      settings: {},
      expectedModelLabel: 'Haiku',
      subscribeToData: (watcher) => {
        dataObserver.current = watcher
        return vi.fn(() => {})
      },
      timeoutMs: 100
    })

    await observer.ready
    observer.arm()
    dataObserver.current('\u001b[2mKept\u001b[9Gmodel\u001b[16Gas ')
    dataObserver.current('Fable 5\u001b[0m')

    await expect(observer.result).resolves.toBe('rejected')
  })

  it('requests interaction for Fable one-time usage-credit consent', async () => {
    const dataObserver = { current: (_data: string): void => {} }
    const observer = createClaudeModelSwitchConfirmationObserver({
      ptyId: 'pty-1',
      settings: {},
      expectedModelLabel: 'Fable 5',
      subscribeToData: (watcher) => {
        dataObserver.current = watcher
        return vi.fn(() => {})
      },
      timeoutMs: 100
    })

    await observer.ready
    observer.arm()
    dataObserver.current('Fable 5 uses usage credits and needs a one-time consent — ')
    dataObserver.current('pick Fable from /model in an interactive session to set it up')

    await expect(observer.result).resolves.toBe('interaction-required')
  })

  it('reports unknown when the PTY observer cannot be established', async () => {
    const observer = createClaudeModelSwitchConfirmationObserver({
      ptyId: 'pty-1',
      settings: {},
      expectedModelLabel: 'Fable 5',
      subscribeToData: () => Promise.reject(new Error('unavailable')),
      timeoutMs: 100
    })

    await observer.ready
    observer.arm()
    await expect(observer.result).resolves.toBe('unknown')
  })

  it('reports unknown on timeout instead of requesting the terminal', async () => {
    vi.useFakeTimers()
    try {
      const observer = createClaudeModelSwitchConfirmationObserver({
        ptyId: 'pty-1',
        settings: {},
        expectedModelLabel: 'Fable 5',
        subscribeToData: () => vi.fn(() => {}),
        timeoutMs: 100
      })

      await observer.ready
      observer.arm()
      observer.startDetection()
      await vi.advanceTimersByTimeAsync(100)
      await expect(observer.result).resolves.toBe('unknown')
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not start the detection timeout until startDetection() is called', async () => {
    vi.useFakeTimers()
    try {
      let settled = false
      const observer = createClaudeModelSwitchConfirmationObserver({
        ptyId: 'pty-1',
        settings: {},
        expectedModelLabel: 'Fable 5',
        subscribeToData: () => vi.fn(() => {}),
        timeoutMs: 100
      })
      void observer.result.then(() => {
        settled = true
      })

      await observer.ready
      observer.arm()
      // Simulates slow SSH send latency between arm() and command delivery: the
      // clock must not run yet, or a successful switch would time out to unknown.
      await vi.advanceTimersByTimeAsync(500)
      expect(settled).toBe(false)

      observer.startDetection()
      await vi.advanceTimersByTimeAsync(100)
      await expect(observer.result).resolves.toBe('unknown')
    } finally {
      vi.useRealTimers()
    }
  })
})
