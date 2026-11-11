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

  it('reads working and idle from the tail of its identity title', () => {
    expect(detectAgentStatusFromTitle('🌐 jcode/fountain Duck · work ~2s')).toBe('working')
    expect(detectAgentStatusFromTitle('🐩 jcode Poodle · +3 -1 · working')).toBe('working')
    expect(detectAgentStatusFromTitle('🌐 jcode/fountain Duck · last ~1m05s')).toBe('idle')
    expect(detectAgentStatusFromTitle('🐩 jcode/marsh Poodle')).toBe('idle')
  })

  it('reads the tail of conversation and SSH titles only in a Jcode pane', () => {
    const conversation = '🦊 Improve session tabs · +12 -3 · work ~2m05s'
    expect(detectAgentStatusFromTitle(conversation)).toBeNull()
    expect(jcodePaneTitleStatus(conversation, 'jcode')).toBe('working')
    expect(jcodePaneTitleStatus(conversation, 'claude')).toBeNull()
    expect(jcodePaneTitleStatus('jcode SSH devbox fox · last ~1h05m', 'jcode')).toBe('idle')
  })

  it('identifies Jcode from its server-qualified session title', () => {
    expect(resolveExplicitTerminalTitleAgentType('🌐 jcode/fountain Duck · work ~2s')).toBe('jcode')
    expect(resolveExplicitTerminalTitleAgentType('✳ Jcode hooks')).not.toBe('jcode')
    expect(resolveExplicitTerminalTitleAgentType('jcode/scripts/build.sh')).not.toBe('jcode')
  })
})
