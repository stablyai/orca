import { describe, expect, it } from 'vitest'
import {
  isExpectedAgentProcess,
  recognizeAgentProcessFromCommandLine
} from './agent-status/process/agent-process-recognition'
import { detectAgentStatusFromTitle } from './agent-status/title/agent-title-status'
import { resolveExplicitTerminalTitleAgentType } from './agent-status/title/terminal-title-agent-type'
import { jcodePaneTitleStatus } from './agent-status/title/providers/jcode-terminal-title'

describe('Jcode pane identity and title status', () => {
  it('recognizes the platform binary the Linux release wrapper execs', () => {
    for (const command of [
      '/home/dev/.local/bin/jcode-versions/0.99.1/jcode-linux-x86_64.bin',
      '/home/dev/.local/bin/jcode-versions/0.99.1/jcode-linux-aarch64.bin --resume fox'
    ]) {
      expect(recognizeAgentProcessFromCommandLine(command)?.agent).toBe('jcode')
      expect(isExpectedAgentProcess(command.split(' ')[0], 'jcode')).toBe(true)
    }
    expect(recognizeAgentProcessFromCommandLine('jcode-helper')).toBeNull()
  })

  it('reads the turn tail only in a Jcode pane', () => {
    for (const title of [
      '🌐 jcode/fountain Duck · work ~2s',
      '🦊 Fix codex hooks · +12 -3 · work ~2m05s',
      '🐩 jcode Poodle · working'
    ]) {
      expect(jcodePaneTitleStatus(title, 'jcode')).toBe('working')
      expect(jcodePaneTitleStatus(title, 'claude')).toBeNull()
    }
    expect(jcodePaneTitleStatus('jcode SSH devbox fox · last ~1h05m', 'jcode')).toBe('idle')
    // Title-only readers see the identity at rest, never a turn a later title would drop.
    expect(detectAgentStatusFromTitle('🌐 jcode/fountain Duck · work ~2s')).toBe('idle')
    expect(detectAgentStatusFromTitle('🦊 Improve session tabs · work ~2m05s')).toBeNull()
  })

  it('identifies Jcode from its server-qualified session title', () => {
    expect(resolveExplicitTerminalTitleAgentType('🌐 jcode/fountain Duck · work ~2s')).toBe('jcode')
    expect(resolveExplicitTerminalTitleAgentType('✳ Jcode hooks')).not.toBe('jcode')
    expect(resolveExplicitTerminalTitleAgentType('jcode/scripts')).not.toBe('jcode')
  })
})
