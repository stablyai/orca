import { describe, expect, it } from 'vitest'
import {
  isAgentForegroundWrapperProcess,
  isExpectedAgentProcess,
  isRecognizedAgentType,
  recognizeAgentProcess,
  recognizeAgentProcessFromCommandLine
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
    expect(recognizeAgentProcess('claude')).toEqual({
      agent: 'claude',
      processName: 'claude'
    })
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

  it('recognizes agent CLIs launched through interpreter wrappers', () => {
    expect(
      recognizeAgentProcessFromCommandLine('node /Users/dev/.nvm/versions/node/bin/codex')
    ).toEqual({ agent: 'codex', processName: 'codex' })
    expect(
      recognizeAgentProcessFromCommandLine('node /Users/dev/.nvm/versions/node/bin/gemini')
    ).toEqual({ agent: 'gemini', processName: 'gemini' })
    expect(recognizeAgentProcessFromCommandLine('python3 /opt/homebrew/bin/hermes --tui')).toEqual({
      agent: 'hermes',
      processName: 'hermes'
    })
    expect(
      recognizeAgentProcessFromCommandLine('python3.12 /opt/homebrew/bin/hermes --tui')
    ).toEqual({
      agent: 'hermes',
      processName: 'hermes'
    })
    expect(recognizeAgentProcessFromCommandLine('python -m aider')).toEqual({
      agent: 'aider',
      processName: 'aider'
    })
    expect(
      recognizeAgentProcessFromCommandLine(
        String.raw`python C:\Users\dev\AppData\Roaming\Python\Python312\Scripts\aider.py`
      )
    ).toEqual({ agent: 'aider', processName: 'aider' })
    expect(
      recognizeAgentProcessFromCommandLine(
        String.raw`node C:\Users\dev\AppData\Roaming\npm\codex.cmd`
      )
    ).toEqual({ agent: 'codex', processName: 'codex' })
    expect(
      recognizeAgentProcessFromCommandLine(
        String.raw`node C:\Users\dev\AppData\Roaming\npm\node_modules\@openai\codex\bin\codex.js`
      )
    ).toEqual({ agent: 'codex', processName: 'codex' })
    expect(
      recognizeAgentProcessFromCommandLine(
        String.raw`node C:\Users\dev\AppData\Roaming\npm\node_modules\@google\gemini-cli\bundle\gemini.mjs`
      )
    ).toEqual({ agent: 'gemini', processName: 'gemini' })
  })

  it('does not classify prompt text as a wrapped agent command', () => {
    expect(
      recognizeAgentProcessFromCommandLine(
        'node /tmp/not-an-agent.js "compare opencode vs orca in Gemini CLI"'
      )
    ).toBeNull()
    expect(recognizeAgentProcessFromCommandLine(String.raw`node C:\tmp\not-an-agent.js`)).toBeNull()
    expect(
      recognizeAgentProcessFromCommandLine(
        String.raw`node C:\repo\server.js --plugin C:\tmp\codex.js`
      )
    ).toBeNull()
    expect(recognizeAgentProcessFromCommandLine(String.raw`node C:\repo\codex.js`)).toBeNull()
    expect(recognizeAgentProcessFromCommandLine(String.raw`node C:\repo\gemini.mjs`)).toBeNull()
    expect(recognizeAgentProcessFromCommandLine(String.raw`python C:\repo\aider.py`)).toBeNull()
    expect(recognizeAgentProcessFromCommandLine('python -m not_aider')).toBeNull()
  })

  it('identifies only foreground processes that can wrap agent entrypoints', () => {
    expect(isAgentForegroundWrapperProcess('node.exe')).toBe(true)
    expect(isAgentForegroundWrapperProcess('/usr/bin/python3')).toBe(true)
    expect(isAgentForegroundWrapperProcess('python3.12.exe')).toBe(true)
    expect(isAgentForegroundWrapperProcess('bash')).toBe(false)
    expect(isAgentForegroundWrapperProcess('vim.exe')).toBe(false)
  })

  it('recognizes versioned Grok process names observed from the installed CLI', () => {
    expect(recognizeAgentProcess('grok-0.2.51')).toEqual({
      agent: 'grok',
      processName: 'grok-0.2.51'
    })
  })
})
