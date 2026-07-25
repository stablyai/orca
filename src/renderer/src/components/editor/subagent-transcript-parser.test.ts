import { describe, it, expect } from 'vitest'
import { isSubagentLogPath, parseSubagentJsonlTranscript } from './subagent-transcript-parser'
import { convertSubagentStepsToNativeChatMessages } from './subagent-transcript-native-chat-messages'

describe('subagent-transcript-parser', () => {
  it('identifies subagent transcript paths correctly', () => {
    expect(
      isSubagentLogPath('/Users/test/.claude/projects/proj/subagents/agent-abc1234.jsonl')
    ).toBe(true)
    expect(
      isSubagentLogPath('C:\\Users\\test\\.claude\\projects\\proj\\subagents\\agent-xyz.jsonl')
    ).toBe(true)
    expect(isSubagentLogPath('/Users/test/normal-file.jsonl')).toBe(false)
    expect(isSubagentLogPath('')).toBe(false)
  })

  it('parses empty raw content safely', () => {
    expect(parseSubagentJsonlTranscript('')).toEqual([])
    expect(parseSubagentJsonlTranscript('   \n  ')).toEqual([])
  })

  it('parses Claude message format with tool_use and thinking', () => {
    const jsonl = [
      JSON.stringify({
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'Please research the codebase' }]
        }
      }),
      JSON.stringify({
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'Analyzing codebase files...' },
            { type: 'tool_use', name: 'grep_search', input: { Query: 'Subagents' } }
          ]
        }
      }),
      JSON.stringify({
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: '123', content: 'Found 5 matches' }]
        }
      }),
      JSON.stringify({
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Analysis completed.' }]
        }
      })
    ].join('\n')

    const steps = parseSubagentJsonlTranscript(jsonl)
    expect(steps).toHaveLength(4)

    expect(steps[0]).toMatchObject({
      type: 'USER_INPUT',
      content: 'Please research the codebase'
    })
    expect(steps[1]).toMatchObject({
      type: 'THINKING',
      content: 'Analyzing codebase files...'
    })
    expect(steps[2]).toMatchObject({
      type: 'TOOL_CALL',
      toolName: 'grep_search',
      toolResult: 'Found 5 matches'
    })
    expect(steps[3]).toMatchObject({
      type: 'MODEL_RESPONSE',
      content: 'Analysis completed.'
    })
  })

  it('parses direct JSON step formats', () => {
    const jsonl = [
      JSON.stringify({ type: 'USER_INPUT', content: 'Run test suite' }),
      JSON.stringify({
        type: 'TOOL_CALL',
        toolName: 'run_command',
        toolArgs: { CommandLine: 'pnpm test' },
        toolResult: 'Pass'
      }),
      JSON.stringify({ type: 'MODEL_RESPONSE', content: 'Tests passed!' })
    ].join('\n')

    const steps = parseSubagentJsonlTranscript(jsonl)
    expect(steps).toHaveLength(3)
    expect(steps[0].type).toBe('USER_INPUT')
    expect(steps[1].type).toBe('TOOL_CALL')
    expect(steps[1].toolName).toBe('run_command')
    expect(steps[2].type).toBe('MODEL_RESPONSE')
  })

  it('converts steps to NativeChat messages format correctly', () => {
    const jsonl = [
      JSON.stringify({
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'Please research the codebase' }]
        }
      }),
      JSON.stringify({
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'Analyzing codebase files...' },
            { type: 'tool_use', name: 'grep_search', input: { Query: 'Subagents' } }
          ]
        }
      })
    ].join('\n')

    const steps = parseSubagentJsonlTranscript(jsonl)
    const nativeMessages = convertSubagentStepsToNativeChatMessages(steps)

    expect(nativeMessages).toHaveLength(3)
    expect(nativeMessages[0].role).toBe('user')
    expect(nativeMessages[0].blocks[0]).toEqual({
      type: 'text',
      text: 'Please research the codebase'
    })

    expect(nativeMessages[1].role).toBe('reasoning')
    expect(nativeMessages[1].blocks[0]).toEqual({
      type: 'text',
      text: 'Analyzing codebase files...'
    })

    expect(nativeMessages[2].role).toBe('assistant')
    expect(nativeMessages[2].blocks[0]).toEqual({
      type: 'tool-call',
      name: 'grep_search',
      input: { Query: 'Subagents' }
    })
  })
})
