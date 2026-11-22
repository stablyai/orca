import { mkdtempSync, writeFileSync } from 'node:fs'
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

const QUESTION = {
  tool_name: 'request_user_input_async',
  tool_use_id: 'question-1',
  tool_input: { questions: [{ title: 'SQLite or Postgres?' }] }
}

function workingBehindQuestion() {
  const report = codexPane()
  report({ hook_event_name: 'UserPromptSubmit', prompt: 'Build the cache' })
  report({ hook_event_name: 'PreToolUse', ...QUESTION })
  const open = report({ hook_event_name: 'PostToolUse', ...QUESTION })
  expect(agentWorksBehindQuestion(open)).toBe(true)
  return report
}

function bash(command: string, id: string) {
  return { tool_name: 'Bash', tool_use_id: id, tool_input: { command } }
}

/** Codex sends PermissionRequest without the call's id. */
function asked({ tool_name, tool_input }: { tool_name: string; tool_input: unknown }) {
  return { tool_name, tool_input }
}

// PermissionRequest names no call, and Codex dispatches parallel calls as they stream in.
it('keeps an approval behind a question until the call that asked ends', () => {
  const report = workingBehindQuestion()
  const build = bash('rm -rf build', 'build')
  report({ hook_event_name: 'PreToolUse', ...build })
  report({ hook_event_name: 'PermissionRequest', ...asked(build) })
  // One call can ask again, for a sandbox retry or network access.
  report({ hook_event_name: 'PermissionRequest', ...asked(build) })

  const lint = bash('pnpm lint', 'lint')
  for (const hook_event_name of ['PreToolUse', 'PostToolUse']) {
    const row = report({ hook_event_name, ...lint })
    expect(row).toMatchObject({ toolName: 'Bash', toolInput: 'rm -rf build' })
    expect(agentWorksBehindQuestion(row)).toBe(false)
  }
  expect(agentWorksBehindQuestion(report({ hook_event_name: 'PostToolUse', ...build }))).toBe(true)
})

it('keeps the first of two approvals when the second resolves first', () => {
  const report = workingBehindQuestion()
  const build = bash('rm -rf build', 'build')
  const publish = bash('pnpm publish', 'publish')
  for (const call of [build, publish]) {
    report({ hook_event_name: 'PreToolUse', ...call })
    report({ hook_event_name: 'PermissionRequest', ...asked(call) })
  }

  const secondDone = report({ hook_event_name: 'PostToolUse', ...publish })
  expect(secondDone).toMatchObject({ toolName: 'Bash', toolInput: 'rm -rf build' })
  expect(agentWorksBehindQuestion(secondDone)).toBe(false)

  // request_user_input takes the exclusive lock, and a refused one sends no PostToolUse.
  report({
    hook_event_name: 'PreToolUse',
    tool_name: 'request_user_input',
    tool_input: { questions: [{ id: 'mode', question: 'Plan or code?' }] }
  })
  const next = report({ hook_event_name: 'PreToolUse', ...bash('pnpm lint', 'lint') })
  expect(agentWorksBehindQuestion(next)).toBe(true)
})

it('keeps an approval when an identical parallel call finishes', () => {
  const report = workingBehindQuestion()
  const inApp = { ...bash('git push', 'in-app'), cwd: '/app' }
  const inApi = { ...bash('git push', 'in-api'), cwd: '/api' }
  report({ hook_event_name: 'PreToolUse', ...inApp })
  report({ hook_event_name: 'PreToolUse', ...inApi })
  report({ hook_event_name: 'PermissionRequest', ...asked(inApp) })

  expect(agentWorksBehindQuestion(report({ hook_event_name: 'PostToolUse', ...inApi }))).toBe(false)
  expect(agentWorksBehindQuestion(report({ hook_event_name: 'PostToolUse', ...inApp }))).toBe(true)
})

// Another PreToolUse hook can rewrite the command: only the two later hooks carry the new one.
it('keeps an approval for a rewritten command while its twin finishes', () => {
  const report = workingBehindQuestion()
  for (const id of ['first', 'second']) {
    report({ hook_event_name: 'PreToolUse', ...bash('git push', id) })
  }
  report({ hook_event_name: 'PermissionRequest', ...asked(bash('proxy git push', 'first')) })

  const twin = report({ hook_event_name: 'PostToolUse', ...bash('proxy git push', 'second') })
  expect(agentWorksBehindQuestion(twin)).toBe(false)
  const done = report({ hook_event_name: 'PostToolUse', ...bash('proxy git push', 'first') })
  expect(agentWorksBehindQuestion(done)).toBe(true)
})

it('keeps an MCP approval until its own call ends, even with rewritten arguments', () => {
  const report = workingBehindQuestion()
  const upload = (id: string) => ({
    tool_name: 'mcp__docs__upload',
    tool_use_id: id,
    tool_input: { file: `/tmp/${id}.pdf` }
  })
  report({ hook_event_name: 'PreToolUse', ...upload('secret') })
  report({ hook_event_name: 'PreToolUse', ...upload('public') })
  report({ hook_event_name: 'PermissionRequest', ...asked(upload('secret')) })

  const sibling = report({ hook_event_name: 'PostToolUse', ...upload('public') })
  expect(agentWorksBehindQuestion(sibling)).toBe(false)
  // Codex swaps file arguments for uploads after approval and before PostToolUse.
  const done = report({
    hook_event_name: 'PostToolUse',
    ...upload('secret'),
    tool_input: { file: { file_id: 'file-1' } }
  })
  expect(agentWorksBehindQuestion(done)).toBe(true)
})

// Esc can land while an accepted call's hooks run; the TUI drops questions with the turn.
it('holds no question accepted as the turn was interrupted', () => {
  const report = codexPane()
  report({ hook_event_name: 'UserPromptSubmit', prompt: 'Build the cache' })
  report({ hook_event_name: 'PreToolUse', ...QUESTION })
  report({ hook_event_name: 'Interrupt' })
  expect(report({ hook_event_name: 'PostToolUse', ...QUESTION }).state).not.toBe('waiting')

  // A queued prompt opens the next turn at once.
  report({ hook_event_name: 'UserPromptSubmit', prompt: 'Use Postgres', turn_id: 'turn-2' })
  expect(report({ hook_event_name: 'PostToolUse', ...QUESTION }).state).not.toBe('waiting')
})

// Codex's approvals reviewer decides these while the turn keeps working.
it('keeps working behind a question while the approvals reviewer decides an approval', () => {
  const rollout = join(mkdtempSync(join(tmpdir(), 'orca-codex-reviewer-')), 'rollout.jsonl')
  writeFileSync(
    rollout,
    `${JSON.stringify({ type: 'turn_context', payload: { approvals_reviewer: 'auto_review' } })}\n`
  )
  const report = codexPane()
  const inTurn = (payload: Record<string, unknown>) =>
    report({ ...payload, transcript_path: rollout })
  inTurn({ hook_event_name: 'UserPromptSubmit', prompt: 'Build the cache' })
  inTurn({ hook_event_name: 'PreToolUse', ...QUESTION })
  inTurn({ hook_event_name: 'PostToolUse', ...QUESTION })
  const build = bash('rm -rf build', 'build')
  inTurn({ hook_event_name: 'PreToolUse', ...build })
  const reviewed = inTurn({ hook_event_name: 'PermissionRequest', ...asked(build) })
  expect(reviewed).toMatchObject({ toolInput: 'SQLite or Postgres?' })
  expect(agentWorksBehindQuestion(reviewed)).toBe(true)
  const lint = bash('pnpm lint', 'lint')
  expect(agentWorksBehindQuestion(inTurn({ hook_event_name: 'PreToolUse', ...lint }))).toBe(true)
})
