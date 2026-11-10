import { describe, expect, it, vi } from 'vitest'
import { createDesktopToastGate } from './desktop-toast-gate'

type State = { kind: 'starting' } | { kind: 'waking' } | { kind: 'failed'; code: string }

describe('createDesktopToastGate', () => {
  it('keeps progress hidden after the user closes it, but still shows a failure', () => {
    const render = vi.fn()
    const hide = vi.fn()
    const gate = createDesktopToastGate<State>({ render, hide })
    gate.show({ kind: 'waking' })
    expect(render).toHaveBeenCalledTimes(1)

    gate.closeByUser()
    expect(hide).toHaveBeenCalledOnce()
    gate.show({ kind: 'starting' })
    expect(render).toHaveBeenCalledTimes(1)

    gate.show({ kind: 'failed', code: 'wake_failed' })
    expect(render).toHaveBeenLastCalledWith({ kind: 'failed', code: 'wake_failed' })
  })

  it('shows every state while the user has not closed it', () => {
    const render = vi.fn()
    const gate = createDesktopToastGate<State>({ render, hide: () => {} })
    gate.show({ kind: 'waking' })
    gate.dismiss()
    gate.show({ kind: 'starting' })
    expect(render).toHaveBeenCalledTimes(2)
  })
})
