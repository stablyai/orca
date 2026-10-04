import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  recognizeAgentProcessFromCommandLine,
  isExpectedAgentProcess
} from './agent-process-recognition'
import {
  getAgentLabel,
  isGeminiTerminalTitle,
  normalizeTerminalTitle,
  detectAgentStatusFromTitle
} from './agent-detection'
import { buildAgentStartupPlan } from './tui-agent-startup'
import { getAgentResumeArgv } from './agent-session-resume'
import { createHookListenerState } from './agent-hook-listener/listener-state'
import { normalizeAndAccept } from './agent-hook-listener-test-harness'

describe('Qoder agent identity and lifecycle', () => {
  it('recognizes the installed versioned binary on native platforms and excludes headless runs', () => {
    for (const command of [
      'qodercli',
      '/home/dev/.qoder/bin/qodercli/qodercli-1.1.64',
      'C:\\Qoder\\qodercli-1.1.64.exe'
    ]) {
      expect(recognizeAgentProcessFromCommandLine(command)?.agent).toBe('qoder')
      expect(isExpectedAgentProcess(command, 'qodercli')).toBe(true)
    }
    expect(recognizeAgentProcessFromCommandLine('qodercli --print hello')).toBeNull()
    for (const args of [
      '-o json',
      '--input-format=stream-json',
      '--remote-control session',
      '--acp',
      '--delete-session 1'
    ]) {
      expect(recognizeAgentProcessFromCommandLine(`qodercli ${args}`)).toBeNull()
    }
    expect(recognizeAgentProcessFromCommandLine('qodercli --prompt-interactive hello')?.agent).toBe(
      'qoder'
    )
    expect(recognizeAgentProcessFromCommandLine('qodercli-unrelated')).toBeNull()
  })

  it.each([
    ['◇ Qoder CLI | Ready', 'idle'],
    ['✦ Implement feature | Thinking', 'working'],
    ['▲ Implement feature | Confirm', 'permission']
  ] as const)('keeps %s attributed through title storage', (title, status) => {
    const stored = normalizeTerminalTitle(title.padEnd(80))
    expect(getAgentLabel(stored)).toBe('Qoder CLI')
    expect(isGeminiTerminalTitle(title)).toBe(false)
    expect(detectAgentStatusFromTitle(stored)).toBe(status)
    expect(normalizeTerminalTitle(stored)).toBe(stored)
  })

  it('keeps upstream Gemini titles and arbitrary triangle text unchanged', () => {
    expect(isGeminiTerminalTitle('✦  Working (project)')).toBe(true)
    expect(getAgentLabel('deploy ▲ complete')).not.toBe('Qoder CLI')
  })

  it('tracks start, work, permission, completion and resume without becoming Claude', () => {
    const state = createHookListenerState()
    const session = { session_id: 'qoder-session', transcript_path: '/tmp/qoder-session.jsonl' }
    const send = (hook_event_name: string, extra = {}) =>
      normalizeAndAccept(state, 'qoder', { ...session, hook_event_name, ...extra })
    const started = send('SessionStart', { source: 'startup' })
    expect(started?.payload).toMatchObject({
      agentType: 'qoder',
      state: 'done',
      sessionBoundary: true
    })
    expect(started?.providerSession).toMatchObject({ id: 'qoder-session' })
    expect(send('UserPromptSubmit', { prompt: 'Fix the bug' })?.payload).toMatchObject({
      state: 'working',
      agentType: 'qoder',
      prompt: 'Fix the bug'
    })
    expect(
      send('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'pwd' } })?.payload
    ).toMatchObject({ state: 'waiting', toolName: 'Bash' })
    expect(send('PostToolUse', { tool_name: 'Bash' })?.payload.state).toBe('working')
    expect(send('SessionStart', { source: 'compact' })).toBeNull()
    expect(send('Stop', { last_assistant_message: 'Fixed.' })?.payload).toMatchObject({
      state: 'done',
      lastAssistantMessage: 'Fixed.'
    })
    expect(send('StopFailure', { error: 'Unavailable' })?.payload.mainAgent).toMatchObject({
      outcome: 'failure'
    })
    expect(getAgentResumeArgv('qoder', { key: 'session_id', id: 'qoder-session' })).toEqual([
      'qodercli',
      '--resume',
      'qoder-session'
    ])
  })
})

it('replays captured unauthenticated startup, prompt, idle and resume hooks', () => {
  const state = createHookListenerState()
  const lines = readFileSync(
    join(__dirname, '__fixtures__', 'qoder-no-account-hooks.jsonl'),
    'utf8'
  )
    .trim()
    .split('\n')
  const events = lines.map((line) => normalizeAndAccept(state, 'qoder', JSON.parse(line)))
  expect(events.map((event) => event?.payload.state)).toEqual([
    'done',
    'working',
    'done',
    'done',
    'done',
    'done'
  ])
  expect(events.every((event) => event?.payload.agentType === 'qoder')).toBe(true)
  expect(events[4]?.payload.sessionBoundary).toBe(true)
  expect(events[4]?.providerSession?.id).toBe(events[0]?.providerSession?.id)
})

it.each(['darwin', 'linux', 'win32'] as const)(
  'launches a Qoder prompt safely on %s',
  (platform) => {
    const plan = buildAgentStartupPlan({
      agent: 'qoder',
      prompt: "fix Bob's branch; echo $HOME",
      cmdOverrides: {},
      platform
    })
    expect(plan?.expectedProcess).toBe('qodercli')
    expect(plan?.followupPrompt).toBeNull()
    expect(plan?.launchCommand).toBe(
      platform === 'win32'
        ? "qodercli --prompt-interactive 'fix Bob''s branch; echo $HOME'"
        : `qodercli --prompt-interactive 'fix Bob'"'"'s branch; echo $HOME'`
    )
  }
)

it('does not rewrite DSH titles containing a pipe as Qoder', () => {
  const title = '✦ 🐋 refactor parser | run tests'
  expect(normalizeTerminalTitle(title)).toBe(title)
  expect(getAgentLabel(title)).not.toBe('Qoder CLI')
  expect(detectAgentStatusFromTitle(title)).not.toBe('working')
})

it('settles manual compaction without interrupting automatic compaction', () => {
  const state = createHookListenerState()
  const send = (hook_event_name: string, extra = {}) =>
    normalizeAndAccept(state, 'qoder', { hook_event_name, ...extra })
  expect(send('UserPromptSubmit', { prompt: 'Refactor' })?.payload.state).toBe('working')
  expect(send('PreCompact', { trigger: 'manual' })).toBeNull()
  expect(send('PostCompact', { trigger: 'auto' })).toBeNull()
  expect(send('SessionStart', { source: 'compact' })).toBeNull()
  expect(send('PostCompact', { trigger: 'manual' })?.payload).toMatchObject({
    state: 'done',
    sessionBoundary: true,
    agentType: 'qoder'
  })
})

it.each(['qoder-cn', 'qwen-code'] as const)('keeps %s lifecycle and resume attributed', (agent) => {
  const state = createHookListenerState()
  const send = (hook_event_name: string, extra = {}) =>
    normalizeAndAccept(state, agent, {
      hook_event_name,
      session_id: 'provider-proof',
      ...extra
    })
  expect(send('SessionStart', { source: 'startup' })?.payload).toMatchObject({
    agentType: agent,
    state: 'done',
    sessionBoundary: true
  })
  expect(send('UserPromptSubmit', { prompt: 'Create proof.txt' })?.payload).toMatchObject({
    agentType: agent,
    state: 'working'
  })
  expect(send('PermissionRequest', { tool_name: 'Write' })?.payload).toMatchObject({
    agentType: agent,
    state: 'waiting'
  })
  expect(send('Stop', { last_assistant_message: 'Done' })?.payload).toMatchObject({
    agentType: agent,
    state: 'done'
  })
  expect(send('SessionStart', { source: 'resume' })?.providerSession?.id).toBe('provider-proof')
  expect(getAgentResumeArgv(agent, { key: 'session_id', id: 'provider-proof' })).toEqual([
    agent === 'qoder-cn' ? 'qoderclicn' : 'qwen',
    '--resume',
    'provider-proof'
  ])
})

it.each([
  'qoderclicn',
  'qodercn',
  '/home/test/.qoder-cn/bin/qoderclicn-1.1.65',
  'C:\\Qoder\\qoderclicn.exe'
])('recognizes the China executable %s', (command) => {
  expect(recognizeAgentProcessFromCommandLine(command)?.agent).toBe('qoder-cn')
  expect(recognizeAgentProcessFromCommandLine(`${command} --print hello`)).toBeNull()
})
