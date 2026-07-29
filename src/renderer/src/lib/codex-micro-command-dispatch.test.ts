import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CodexMicroSettings } from '../../../shared/codex-micro-settings'
import { registerAppCommandDispatcher } from './app-command-dispatch'
import { dispatchCodexMicroInput } from './codex-micro-command-dispatch'

const settings: CodexMicroSettings = {
  enabled: true,
  lightingEnabled: false,
  brightness: 100,
  idleTimeoutSeconds: 300,
  dialMode: 'navigate',
  mappings: {
    AG00: 'worktree.navigateUp',
    ENC_CC: 'worktree.navigateDown'
  }
}

let cleanup = (): void => {}

afterEach(() => cleanup())

describe('dispatchCodexMicroInput', () => {
  it('dispatches mapped button presses once and ignores releases', () => {
    const dispatch = vi.fn(() => true)
    cleanup = registerAppCommandDispatcher(dispatch)

    expect(dispatchCodexMicroInput({ kind: 'control', control: 'AG00', action: 1 }, settings)).toBe(
      true
    )
    expect(dispatchCodexMicroInput({ kind: 'control', control: 'AG00', action: 0 }, settings)).toBe(
      false
    )
    expect(dispatch).toHaveBeenCalledOnce()
  })

  it('dispatches encoder steps only on action 2', () => {
    const dispatch = vi.fn(() => true)
    cleanup = registerAppCommandDispatcher(dispatch)
    expect(
      dispatchCodexMicroInput({ kind: 'control', control: 'ENC_CC', action: 2 }, settings)
    ).toBe(true)
    expect(
      dispatchCodexMicroInput({ kind: 'control', control: 'ENC_CC', action: 1 }, settings)
    ).toBe(false)
  })

  it('ignores radar, disabled ownership, and unassigned controls', () => {
    const dispatch = vi.fn(() => true)
    cleanup = registerAppCommandDispatcher(dispatch)
    expect(dispatchCodexMicroInput({ kind: 'radar', angle: 90, distance: 2 }, settings)).toBe(false)
    expect(
      dispatchCodexMicroInput(
        { kind: 'control', control: 'AG00', action: 1 },
        { ...settings, enabled: false }
      )
    ).toBe(false)
    expect(dispatchCodexMicroInput({ kind: 'control', control: 'AG01', action: 1 }, settings)).toBe(
      false
    )
  })
})
