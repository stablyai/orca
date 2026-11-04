import { describe, expect, it } from 'vitest'
import {
  hasCodexNativeDraftFlag,
  shouldUseShellReadyStartupDelivery
} from './codex-startup-delivery'

describe('hasCodexNativeDraftFlag', () => {
  it('matches Codex --prefill option tokens', () => {
    expect(hasCodexNativeDraftFlag("codex --prefill 'linked issue context'")).toBe(true)
    expect(hasCodexNativeDraftFlag("codex --model gpt-5 --prefill 'draft'")).toBe(true)
  })

  it('matches Codex --prefill=value option tokens', () => {
    expect(hasCodexNativeDraftFlag('codex --prefill=review')).toBe(true)
    expect(hasCodexNativeDraftFlag("codex --prefill='linked issue context'")).toBe(true)
  })

  it('does not match quoted prompt text mentioning prefill', () => {
    expect(hasCodexNativeDraftFlag("codex 'please compare --prefill behavior'")).toBe(false)
    expect(hasCodexNativeDraftFlag("codex '--prefill=not-an-option'")).toBe(false)
  })

  it('does not match non-Codex commands', () => {
    expect(hasCodexNativeDraftFlag("claude --prefill 'review this'")).toBe(false)
  })

  it('leaves plain Codex and normal Codex arguments on the fast path', () => {
    expect(hasCodexNativeDraftFlag('codex')).toBe(false)
    expect(hasCodexNativeDraftFlag('codex --model gpt-5')).toBe(false)
  })
})

describe('shouldUseShellReadyStartupDelivery', () => {
  it('honours an explicit shell-ready hint whatever the command', () => {
    expect(
      shouldUseShellReadyStartupDelivery({
        command: 'claude',
        startupCommandDelivery: 'shell-ready'
      })
    ).toBe(true)
  })

  it('keeps plain Codex on the fast path when the shell is unknown', () => {
    expect(shouldUseShellReadyStartupDelivery({ command: 'codex' })).toBe(false)
  })

  it('waits for plain Codex on shells that publish the marker from the line editor', () => {
    expect(shouldUseShellReadyStartupDelivery({ command: 'codex', shellPath: '/bin/bash' })).toBe(
      true
    )
    expect(
      shouldUseShellReadyStartupDelivery({ command: 'codex', shellPath: '/opt/homebrew/bin/zsh' })
    ).toBe(true)
  })

  it('leaves plain Codex unwaited on shells that emit the marker before the reader', () => {
    expect(
      shouldUseShellReadyStartupDelivery({ command: 'codex', shellPath: '/usr/bin/fish' })
    ).toBe(false)
  })

  it('does not change non-Codex commands, which their transports already wait for', () => {
    expect(shouldUseShellReadyStartupDelivery({ command: 'claude', shellPath: '/bin/bash' })).toBe(
      false
    )
    expect(shouldUseShellReadyStartupDelivery({ command: undefined, shellPath: '/bin/bash' })).toBe(
      false
    )
  })
})
