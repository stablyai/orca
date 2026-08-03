import { describe, expect, it } from 'vitest'
import {
  applyShellCommandWrapper,
  normalizeShellCommandWrapper,
  SHELL_COMMAND_WRAPPER_PLACEHOLDERS
} from './shell-command-wrapper'

describe('normalizeShellCommandWrapper', () => {
  it('trims and drops blank wrappers', () => {
    expect(normalizeShellCommandWrapper(undefined)).toBeUndefined()
    expect(normalizeShellCommandWrapper(null)).toBeUndefined()
    expect(normalizeShellCommandWrapper('')).toBeUndefined()
    expect(normalizeShellCommandWrapper('   ')).toBeUndefined()
    expect(normalizeShellCommandWrapper('  devenv shell -- $CMD  ')).toBe('devenv shell -- $CMD')
  })
})

describe('applyShellCommandWrapper', () => {
  it('is a no-op without a wrapper', () => {
    expect(applyShellCommandWrapper(undefined, "claude 'hello world'")).toBe("claude 'hello world'")
    expect(applyShellCommandWrapper('', "claude 'hello world'")).toBe("claude 'hello world'")
    expect(applyShellCommandWrapper('   ', "claude 'hello world'")).toBe("claude 'hello world'")
  })

  it('is a no-op when the command is blank', () => {
    expect(applyShellCommandWrapper('devenv shell -- $CMD', '')).toBe('')
    expect(applyShellCommandWrapper('devenv shell -- $CMD', '   ')).toBe('')
    expect(applyShellCommandWrapper('devenv shell -- $CMD', null)).toBe('')
    expect(applyShellCommandWrapper('devenv shell -- $CMD', undefined)).toBe('')
  })

  it('substitutes $CMD for devenv-style wrappers without re-quoting', () => {
    expect(applyShellCommandWrapper('devenv shell -- $CMD', "claude --yolo 'fix me'")).toBe(
      "devenv shell -- claude --yolo 'fix me'"
    )
  })

  it('prefers $COMMAND over $CMD so longer placeholder wins', () => {
    expect(applyShellCommandWrapper('env $COMMAND', 'echo hi')).toBe('env echo hi')
    expect(applyShellCommandWrapper('run $CMD', 'echo hi')).toBe('run echo hi')
  })

  it('substitutes {command} placeholder', () => {
    expect(applyShellCommandWrapper('nix-shell --run {command}', "echo 'a b'")).toBe(
      "nix-shell --run echo 'a b'"
    )
  })

  it('treats templates without a placeholder as a prefix', () => {
    expect(applyShellCommandWrapper('devenv shell --', 'claude')).toBe('devenv shell -- claude')
  })

  it('replaces every placeholder occurrence', () => {
    expect(applyShellCommandWrapper('echo $CMD && $CMD', 'true')).toBe('echo true && true')
  })

  it('replaces every supported placeholder variant in mixed templates', () => {
    expect(applyShellCommandWrapper('echo $CMD && {command}', 'true')).toBe('echo true && true')
    expect(applyShellCommandWrapper('log $COMMAND then $CMD then {command}', 'run')).toBe(
      'log run then run then run'
    )
  })

  it('exposes placeholders longest-first for callers that mirror the order', () => {
    expect([...SHELL_COMMAND_WRAPPER_PLACEHOLDERS]).toEqual(['$COMMAND', '$CMD', '{command}'])
  })
})
