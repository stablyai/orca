// @vitest-environment happy-dom

import { describe, expect, it, vi } from 'vitest'
import { createClaudeModelSwitchConfirmationObserver } from './claude-model-switch-confirmation'

describe('Claude model switch confirmation detection', () => {
  it('reports matching success output split across PTY chunks', async () => {
    const dataObserver = { current: (_data: string): void => {} }
    const unsubscribe = vi.fn(() => {})
    const observer = createClaudeModelSwitchConfirmationObserver({
      ptyId: 'pty-1',
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
})
