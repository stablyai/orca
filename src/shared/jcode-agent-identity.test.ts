import { describe, expect, it } from 'vitest'
import {
  isExpectedAgentProcess,
  recognizeAgentProcessFromCommandLine
} from './agent-status/process/agent-process-recognition'
import { detectAgentStatusFromTitle } from './agent-status/title/agent-title-status'
import { resolveExplicitTerminalTitleAgentType } from './agent-status/title/terminal-title-agent-type'

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

  it('reads working and idle from the tail Jcode appends to its title', () => {
    expect(detectAgentStatusFromTitle('🌐 jcode/fountain Duck · work ~2s')).toBe('working')
    expect(detectAgentStatusFromTitle('🦊 Improve session tabs · +12 -3 · work ~2m05s')).toBe(
      'working'
    )
    expect(detectAgentStatusFromTitle('🦊 Improve session tabs · working')).toBe('working')
    expect(detectAgentStatusFromTitle('🌐 jcode/fountain Duck · last ~1m05s')).toBe('idle')
    expect(detectAgentStatusFromTitle('🌐 jcode/fountain Duck')).toBe('idle')
    expect(detectAgentStatusFromTitle('✳ Fix jcode · work ~2s')).toBe('idle')
  })

  it('identifies Jcode from its server-qualified session title', () => {
    expect(resolveExplicitTerminalTitleAgentType('🌐 jcode/fountain Duck · work ~2s')).toBe('jcode')
    expect(resolveExplicitTerminalTitleAgentType('✳ Jcode hooks')).not.toBe('jcode')
  })
})
