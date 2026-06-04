import { describe, expect, it } from 'vitest'
import {
  isExpectedAgentProcess,
  isRecognizedAgentType,
  recognizeAgentProcess
} from './agent-process-recognition'

describe('agent process recognition', () => {
  it('recognizes packaged Codex foreground process names', () => {
    expect(recognizeAgentProcess('codex-aarch64-ap')).toEqual({
      agent: 'codex',
      processName: 'codex-aarch64-ap'
    })
    expect(isRecognizedAgentType('codex-aarch64-ap')).toBe(true)
  })

  it('recognizes the OpenClaude foreground process', () => {
    expect(recognizeAgentProcess('/usr/local/bin/openclaude')).toEqual({
      agent: 'openclaude',
      processName: 'openclaude'
    })
    expect(isRecognizedAgentType('openclaude')).toBe(true)
    expect(isExpectedAgentProcess('/usr/local/bin/openclaude', 'claude')).toBe(false)
  })

  it('matches expected agents from platform-specific foreground process paths', () => {
    expect(
      isExpectedAgentProcess(String.raw`C:\Users\dev\AppData\Roaming\npm\claude.exe`, 'claude')
    ).toBe(true)
    expect(isExpectedAgentProcess('/usr/local/bin/claude', 'claude')).toBe(true)
    expect(isExpectedAgentProcess('powershell.exe', 'claude')).toBe(false)
  })

  it('recognizes Command Code without classifying Windows cmd.exe as an agent', () => {
    expect(recognizeAgentProcess('command-code')).toEqual({
      agent: 'command-code',
      processName: 'command-code'
    })
    expect(
      recognizeAgentProcess(String.raw`C:\Users\dev\AppData\Roaming\npm\command-code.cmd`)
    ).toEqual({
      agent: 'command-code',
      processName: 'command-code'
    })
    expect(isRecognizedAgentType('command-code')).toBe(true)
    expect(isRecognizedAgentType('cmd.exe')).toBe(false)
    expect(recognizeAgentProcess('cmd.exe')).toBeNull()
  })

  it('recognizes Mistral Vibe by its installed executable and legacy alias', () => {
    expect(recognizeAgentProcess('/home/dev/.local/bin/vibe')).toEqual({
      agent: 'mistral-vibe',
      processName: 'vibe'
    })
    expect(recognizeAgentProcess('mistral-vibe')).toEqual({
      agent: 'mistral-vibe',
      processName: 'mistral-vibe'
    })
    expect(isRecognizedAgentType('vibe')).toBe(true)
  })
})
