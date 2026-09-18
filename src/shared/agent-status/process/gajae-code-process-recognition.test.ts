import { describe, expect, it } from 'vitest'
import {
  isExpectedAgentProcess,
  isRecognizedAgentType,
  recognizeAgentProcess,
  recognizeAgentProcessFromCommandLine
} from './agent-process-recognition'

describe('gajae-code process recognition', () => {
  it('recognizes Gajae Code by its gjc binary and gajae-code alias', () => {
    expect(recognizeAgentProcess('gjc')).toEqual({
      agent: 'gajae-code',
      processName: 'gjc'
    })
    expect(recognizeAgentProcess('/Users/dev/.local/bin/gjc')).toEqual({
      agent: 'gajae-code',
      processName: 'gjc'
    })
    expect(recognizeAgentProcess('gajae-code')).toEqual({
      agent: 'gajae-code',
      processName: 'gajae-code'
    })
    expect(
      recognizeAgentProcess(String.raw`C:\Users\dev\AppData\Roaming\npm\gajae-code.exe`)
    ).toEqual({
      agent: 'gajae-code',
      processName: 'gajae-code'
    })
    expect(recognizeAgentProcessFromCommandLine('gjc')).toEqual({
      agent: 'gajae-code',
      processName: 'gjc'
    })
    expect(isExpectedAgentProcess('/Users/dev/.local/bin/gjc', 'gjc')).toBe(true)
    expect(isRecognizedAgentType('gjc')).toBe(true)
    expect(isRecognizedAgentType('gajae-code')).toBe(true)
    expect(recognizeAgentProcess('mimo')).toEqual({ agent: 'mimo-code', processName: 'mimo' })
    expect(recognizeAgentProcess('claude')).toEqual({ agent: 'claude', processName: 'claude' })
  })
})
