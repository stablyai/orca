import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  forgetRetiredTerminalPaneRecovery,
  registerTerminalPaneRecoveryRetirementHandler
} from './terminal-pane-recovery-retirement'

describe('terminal pane recovery retirement bridge', () => {
  let unregister: (() => void) | undefined

  afterEach(() => unregister?.())

  it('routes authoritative retirement without coupling the store to recovery state', () => {
    const handler = vi.fn()
    unregister = registerTerminalPaneRecoveryRetirementHandler(handler)

    forgetRetiredTerminalPaneRecovery('tab-1')

    expect(handler).toHaveBeenCalledWith('tab-1')
  })

  it('does not retain a retired module handler', () => {
    const handler = vi.fn()
    unregister = registerTerminalPaneRecoveryRetirementHandler(handler)
    unregister()
    unregister = undefined

    forgetRetiredTerminalPaneRecovery('tab-1')

    expect(handler).not.toHaveBeenCalled()
  })
})
