// @vitest-environment happy-dom

import { describe, expect, it, vi } from 'vitest'
import { createClaudeModelSwitchConfirmationObserver } from './claude-model-switch-confirmation'

describe('Claude model switch confirmation detection', () => {
  it('does not confirm success before the warning Enter is actually accepted', async () => {
    const data = { current: (_text: string): void => {} }
    const written = Promise.withResolvers<boolean>()
    const confirm = vi.fn(() => written.promise)
    const observer = createClaudeModelSwitchConfirmationObserver({
      ptyId: 'pty-1',
      expectedModelLabel: 'Opus 5.5',
      subscribeToData: (watcher) => {
        data.current = watcher
        return () => {}
      },
      submitConfirmation: confirm
    })
    await observer.ready
    observer.arm()
    observer.startDetection()
    data.current('Switch model? This conversation is cached for the current model')
    data.current('Set model to Opus 5.5')
    written.resolve(false)
    await expect(observer.result).resolves.toBe('unknown')
    expect(confirm).toHaveBeenCalledOnce()
  })

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
