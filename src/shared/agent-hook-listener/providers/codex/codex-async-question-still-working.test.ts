import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { agentWorksBehindQuestion } from '../../../agent-status/lifecycle/agent-works-behind-question'
import { createHookListenerState } from '../../listener-state'
import { normalizeHookPayload } from '../../normalization/normalize-hook-payload'

const TURN = { session_id: 'session-1', turn_id: 'turn-1' }

function codexPane() {
  const state = createHookListenerState()
  return (payload: Record<string, unknown>) => {
    const event = normalizeHookPayload(
      state,
      'codex',
      {
        paneKey: 'tab-1:11111111-1111-4111-8111-111111111111',
        tabId: 'tab-1',
        worktreeId: 'folder-workspace',
        env: 'production',
        version: '1',
        payload: { ...TURN, ...payload }
      },
      'production'
    )
    if (!event) {
      throw new Error('Expected a Codex status')
    }
    return event.payload
  }
}

// Codex 0.171 runs PreToolUse before it validates the call and PostToolUse only once it accepts it.
function askQuestion(
  report: ReturnType<typeof codexPane>,
  questions: unknown[],
  extra: Record<string, unknown> = {}
) {
  const call = {
    tool_name: 'request_user_input_async',
    tool_use_id: 'call-1',
    tool_input: { questions },
    ...extra
  }
  report({ hook_event_name: 'PreToolUse', ...call })
  return report({ hook_event_name: 'PostToolUse', ...call, tool_response: '{"accepted":true}' })
}

it('reports Codex as still working behind an async question, but not behind a blocking wait', () => {
  const report = codexPane()
  report({ hook_event_name: 'UserPromptSubmit', prompt: 'Build the cache' })
  askQuestion(report, [{ title: 'SQLite or Postgres?', options: ['SQLite', 'Postgres'] }])

  const running = report({
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'pnpm build' }
  })
  expect(running).toMatchObject({
    state: 'waiting',
    toolName: 'request_user_input_async',
    toolInput: 'SQLite or Postgres?'
  })
  expect(agentWorksBehindQuestion(running)).toBe(true)

  const approval = report({
    hook_event_name: 'PermissionRequest',
    tool_name: 'Bash',
    tool_input: { command: 'pnpm build' }
  })
  expect(agentWorksBehindQuestion(approval)).toBe(false)

  expect(
    agentWorksBehindQuestion(
      report({
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'pnpm build' }
      })
    )
  ).toBe(true)

  const childBlocked = report({
    hook_event_name: 'PermissionRequest',
    agent_id: 'child-1',
    tool_name: 'Bash',
    tool_input: { command: 'pnpm publish' }
  })
  expect(agentWorksBehindQuestion(childBlocked)).toBe(false)

  expect(agentWorksBehindQuestion(report({ hook_event_name: 'Stop' }))).toBe(false)
})

// Codex sends some approvals to the user even under auto-review (`requires_human_approval`).
it('never hides an approval behind an open question, even under auto-review', () => {
  const directory = mkdtempSync(join(tmpdir(), 'orca-codex-question-'))
  try {
    const transcript_path = join(directory, 'rollout.jsonl')
    writeFileSync(
      transcript_path,
      `${JSON.stringify({ type: 'turn_context', payload: { turn_id: 'turn-1', approvals_reviewer: 'auto_review' } })}\n`
    )
    const report = codexPane()
    report({ hook_event_name: 'UserPromptSubmit', prompt: 'Build the cache', transcript_path })
    askQuestion(report, [{ title: 'SQLite or Postgres?' }], { transcript_path })

    const approval = report({
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'pnpm publish' },
      transcript_path
    })
    expect(approval).toMatchObject({ toolName: 'Bash', toolInput: 'pnpm publish' })
    expect(agentWorksBehindQuestion(approval)).toBe(false)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

it('keeps an approval on screen when a parallel call finishes behind an open question', () => {
  const report = codexPane()
  report({ hook_event_name: 'UserPromptSubmit', prompt: 'Build the cache' })
  askQuestion(report, [{ title: 'SQLite or Postgres?' }])
  report({
    hook_event_name: 'PermissionRequest',
    tool_name: 'Bash',
    tool_input: { command: 'rm -rf build' }
  })

  const parallel = report({
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'pnpm lint' }
  })
  expect(parallel).toMatchObject({ toolName: 'Bash', toolInput: 'rm -rf build' })
  expect(agentWorksBehindQuestion(parallel)).toBe(false)

  const approved = report({
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'rm -rf build' }
  })
  expect(agentWorksBehindQuestion(approved)).toBe(true)
})

it('holds no question for a call Codex refused', () => {
  const report = codexPane()
  report({ hook_event_name: 'UserPromptSubmit', prompt: 'Build the cache' })
  report({
    hook_event_name: 'PreToolUse',
    tool_name: 'request_user_input_async',
    tool_use_id: 'call-1',
    tool_input: { questions: [{ title: 'SQLite or Postgres?', options: [] }] }
  })

  const next = report({
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'pnpm build' }
  })
  expect(next).toMatchObject({ state: 'working', toolName: 'Bash' })
  expect(next.interactivePrompt).toBeUndefined()
})
