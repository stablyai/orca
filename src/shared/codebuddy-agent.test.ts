import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createHookListenerState } from './agent-hook-listener/listener-state'
import { normalizeAndAccept } from './agent-hook-listener-test-harness'
import { recognizeAgentProcessFromCommandLine } from './agent-process-recognition'
import { getAgentSessionOptionCatalog } from './agent-session-option-catalog'
import { getAgentResumeArgv } from './agent-session-resume'

describe('CodeBuddy harness', () => {
  it('replays the live question lifecycle without settling at late SessionStart', () => {
    const state = createHookListenerState()
    const events = readFileSync(
      join(__dirname, '__fixtures__/codebuddy-question-hooks.jsonl'),
      'utf8'
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    const rows = events.map((event) => normalizeAndAccept(state, 'codebuddy', event))
    expect(rows.map((row) => row?.payload.state ?? null)).toEqual([
      'working',
      null,
      'waiting',
      'working',
      'working',
      'done'
    ])
    expect(rows[2]?.payload).toMatchObject({ agentType: 'codebuddy', toolName: 'AskUserQuestion' })
    expect(rows[5]?.payload).toMatchObject({ agentType: 'codebuddy', lastAssistantMessage: 'Red' })
    expect(rows[5]?.providerSession?.id).toBe('codebuddy-verification')
  })

  it.each([
    'codebuddy',
    'cbc',
    'C:\\Tools\\codebuddy.cmd',
    'node /usr/lib/node_modules/@tencent-ai/codebuddy-code/dist/codebuddy.js'
  ])('recognizes interactive %s', (command) => {
    expect(recognizeAgentProcessFromCommandLine(command)?.agent).toBe('codebuddy')
  })

  it('excludes print runs and resumes the original provider session', () => {
    for (const flag of ['--print', '--serve', '--acp', '--bg', '--background']) {
      expect(recognizeAgentProcessFromCommandLine(`codebuddy ${flag}`)).toBeNull()
    }
    expect(recognizeAgentProcessFromCommandLine('codebuddy -- --serve')?.agent).toBe('codebuddy')
    expect(getAgentResumeArgv('codebuddy', { key: 'session_id', id: 'session-1' })).toEqual([
      'codebuddy',
      '--resume',
      'session-1'
    ])
  })

  it('passes explicit model and effort preferences through the CLI flags', () => {
    const catalog = getAgentSessionOptionCatalog('codebuddy')
    expect(catalog?.modelApply.launchArgs?.('fast-model')).toEqual(['--model', 'fast-model'])
    expect(catalog?.unknownModelOptions?.[0].apply.launchArgs?.('high')).toEqual([
      '--effort',
      'high'
    ])
    expect(catalog?.modelApply.removeAgentArgs?.(['--model', 'old', '--', 'prompt'])).toEqual([
      '--',
      'prompt'
    ])
  })
})
