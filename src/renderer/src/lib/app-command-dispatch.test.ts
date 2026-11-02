import { afterEach, describe, expect, it, vi } from 'vitest'
import { dispatchAppCommand, registerAppCommandDispatcher } from './app-command-dispatch'

let cleanup: (() => void) | null = null

afterEach(() => cleanup?.())

describe('app command dispatch', () => {
  it('rejects unknown actions and unregisters only the current dispatcher', () => {
    const staleCleanup = registerAppCommandDispatcher(() => true)
    const current = vi.fn(() => true)
    cleanup = registerAppCommandDispatcher(current)
    staleCleanup()

    expect(dispatchAppCommand('missing.action', 'plugin-keybinding')).toBe(false)
    expect(dispatchAppCommand('view.tasks', 'plugin-keybinding')).toBe(true)
    cleanup()
    cleanup = null
    expect(dispatchAppCommand('view.tasks', 'plugin-keybinding')).toBe(false)
  })
})
