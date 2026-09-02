import { describe, expect, it } from 'vitest'
import { isMeaningfulOpenCodeTerminalTitle, isOpenCodeNativeTitle } from './opencode-terminal-title'

describe('OpenCode terminal titles', () => {
  it('recognizes native session titles', () => {
    expect(isMeaningfulOpenCodeTerminalTitle('OC | Native Stable Session')).toBe(true)
    expect(isMeaningfulOpenCodeTerminalTitle('  OC | Session  ')).toBe(true)
    expect(isOpenCodeNativeTitle('OC | Understand about the plugin')).toBe(true)
    expect(isOpenCodeNativeTitle('tmux | OC | ses_123')).toBe(true)
    expect(isOpenCodeNativeTitle('ssh build-host | OC | ses_123')).toBe(true)
    expect(isOpenCodeNativeTitle('user@host: ~/code | OC | ses_123')).toBe(true)
    expect(isOpenCodeNativeTitle('▣ OC | ses_123')).toBe(true)
    expect(isOpenCodeNativeTitle('⠋ OC | ses_123')).toBe(true)
    expect(isOpenCodeNativeTitle('ssh build-host | ⠋ OC | ses_123')).toBe(true)
    expect(isOpenCodeNativeTitle('OC |   ses_123')).toBe(true)
    expect(isOpenCodeNativeTitle('OC |\tses_123')).toBe(true)
  })

  it('rejects generic, incomplete, embedded, and lookalike titles', () => {
    expect(isMeaningfulOpenCodeTerminalTitle('OpenCode')).toBe(false)
    expect(isMeaningfulOpenCodeTerminalTitle('OpenCode ready')).toBe(false)
    expect(isMeaningfulOpenCodeTerminalTitle('OC |')).toBe(false)
    // Why: the native marker always spaces its separator; `OC|x` is another tool's
    // pipe-delimited title, so accepting it would make a non-OpenCode pane a send target.
    expect(isMeaningfulOpenCodeTerminalTitle('OC|Session')).toBe(false)
    expect(isMeaningfulOpenCodeTerminalTitle('OC |Session')).toBe(false)
    expect(isMeaningfulOpenCodeTerminalTitle(undefined)).toBe(false)
    // Why: lowercase is not OpenCode's native marker; avoid "oc |" cwd/task noise.
    expect(isOpenCodeNativeTitle('oc | Understand about the plugin')).toBe(false)
    // Why: mid-title OC must not steal another agent's braille/task frame.
    expect(isOpenCodeNativeTitle('⠋ Fix foo | OC | bar')).toBe(false)
  })
})
