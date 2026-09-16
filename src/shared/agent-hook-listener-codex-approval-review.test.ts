import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { normalizeHookPayload } from './agent-hook-listener'
import { createHookListenerState } from './agent-hook-listener/listener-state'
import { reconcileRemoteCodexState } from './agent-hook-listener/providers/codex-state'
import { PANE_KEY } from './agent-hook-listener-test-harness'

describe('Codex approval reviewer from the execution-host transcript', () => {
  let directory: string
  let transcriptPath: string
  let state = createHookListenerState()

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'codex-approval-review-'))
    transcriptPath = join(directory, 'rollout-parent.jsonl')
    state = createHookListenerState()
  })

  afterEach(() => rmSync(directory, { recursive: true, force: true }))

  function context(turnId: string, reviewer: unknown): void {
    appendFileSync(
      transcriptPath,
      `${JSON.stringify({
        type: 'turn_context',
        payload: { turn_id: turnId, approvals_reviewer: reviewer }
      })}\n`
    )
  }

  function hook(event: string, overrides: Record<string, unknown> = {}) {
    return normalizeHookPayload(
      state,
      'codex',
      {
        paneKey: PANE_KEY,
        tabId: 'tab-1',
        worktreeId: 'folder-workspace',
        env: 'production',
        version: '1',
        payload: {
          hook_event_name: event,
          transcript_path: transcriptPath,
          turn_id: 'turn-1',
          tool_name: 'Bash',
          tool_input: { command: 'git status' },
          ...overrides
        }
      },
      'production'
    )?.payload
  }

  it('keeps automatic review working without publishing a human approval prompt', () => {
    context('turn-1', 'auto_review')
    const approval = hook('PermissionRequest')
    expect(approval).toMatchObject({ state: 'working', agentType: 'codex', toolName: 'Bash' })
    expect(approval?.interactivePrompt).toBeUndefined()
  })

  it.each(['exec_command', 'shell_command', 'shell', 'apply_patch'])(
    'recognizes sandbox approval for %s',
    (toolName) => {
      context('turn-1', 'auto_review')
      expect(hook('PermissionRequest', { tool_name: toolName })?.state).toBe('working')
    }
  )

  it.each(['mcp__computer__browser', 'unknown_tool', undefined])(
    'preserves approvals outside the known sandbox tools: %s',
    (toolName) => {
      context('turn-1', 'auto_review')
      expect(hook('PermissionRequest', { tool_name: toolName })?.state).toBe('waiting')
    }
  )

  it('retains the reviewer across incremental reads and a long tool output', () => {
    context('turn-1', 'auto_review')
    hook('PreToolUse')
    appendFileSync(transcriptPath, `${'x'.repeat(2 * 1024 * 1024)}\n`)
    expect(hook('PermissionRequest')?.state).toBe('working')
    expect(hook('PermissionRequest')?.state).toBe('working')
  })

  it.each(['user', undefined, null, 'unknown'])(
    'preserves human attention for reviewer %s',
    (reviewer) => {
      context('turn-1', reviewer)
      const approval = hook('PermissionRequest')
      expect(approval?.state).toBe('waiting')
      expect(approval?.interactivePrompt).toBeDefined()
    }
  )

  it.each(['PreToolUse', 'PermissionRequest'])(
    'preserves user questions on %s during auto-review',
    (event) => {
      context('turn-1', 'auto_review')
      expect(hook(event, { tool_name: 'request_user_input' })?.state).toBe('waiting')
    }
  )

  it('does not borrow a reviewer from another turn or an uncorrelated hook', () => {
    context('turn-1', 'auto_review')
    hook('PreToolUse')
    expect(hook('PermissionRequest', { turn_id: 'turn-2' })?.state).toBe('waiting')
    expect(hook('PermissionRequest', { turn_id: undefined })?.state).toBe('waiting')
    expect(hook('PermissionRequest', { transcript_path: undefined })?.state).toBe('waiting')
  })

  it('honors a later turn switching back to human approval', () => {
    context('turn-1', 'auto_review')
    hook('PreToolUse')
    context('turn-2', 'user')
    expect(hook('PermissionRequest', { turn_id: 'turn-2' })?.state).toBe('waiting')
  })

  it('does not retain auto-review when the next context omits the reviewer', () => {
    context('turn-1', 'auto_review')
    hook('PreToolUse')
    appendFileSync(transcriptPath, '{"type":"turn_context","payload":{"turn_id":"turn-1"}}\n')
    expect(hook('PermissionRequest')?.state).toBe('waiting')
  })

  it('does not retain auto-review after a transcript disappears or is truncated', () => {
    context('turn-1', 'auto_review')
    hook('PreToolUse')
    writeFileSync(transcriptPath, '')
    expect(hook('PermissionRequest')?.state).toBe('waiting')
    context('turn-1', 'auto_review')
    hook('PreToolUse')
    rmSync(transcriptPath)
    expect(hook('PermissionRequest')?.state).toBe('waiting')
  })

  it('does not borrow the previous session reviewer after a transcript path changes', () => {
    context('turn-1', 'auto_review')
    hook('PreToolUse')
    const otherPath = join(directory, 'rollout-other.jsonl')
    writeFileSync(otherPath, '')
    expect(hook('PermissionRequest', { transcript_path: otherPath })?.state).toBe('waiting')
  })

  it('does not infer a child reviewer from its parent', () => {
    context('turn-1', 'auto_review')
    hook('PreToolUse')
    expect(hook('PermissionRequest', { agent_id: 'child' })?.state).toBe('waiting')
  })

  it('keeps a human child approval visible while the parent is automatically reviewed', () => {
    context('turn-1', 'auto_review')
    hook('PreToolUse')
    hook('PermissionRequest', { agent_id: 'child' })
    expect(hook('PermissionRequest')?.state).toBe('waiting')
  })

  it('reads a child reviewer only from that child transcript and turn', () => {
    context('turn-1', 'user')
    appendFileSync(
      transcriptPath,
      `${JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'sub_agent_activity',
          agent_thread_id: 'child',
          kind: 'started',
          occurred_at_ms: Date.now()
        }
      })}\n`
    )
    const childPath = join(directory, 'rollout-child.jsonl')
    writeFileSync(
      childPath,
      `${JSON.stringify({
        type: 'turn_context',
        payload: {
          turn_id: 'child-turn',
          approvals_reviewer: 'auto_review'
        }
      })}\n`
    )
    hook('PreToolUse')
    expect(
      hook('PermissionRequest', {
        agent_id: 'child',
        transcript_path: childPath,
        turn_id: 'child-turn'
      })?.state
    ).toBe('working')
  })

  it('preserves a relay-normalized automatic review when main reconciles the lead state', () => {
    context('turn-1', 'auto_review')
    const approval = hook('PermissionRequest')
    expect(approval).toBeDefined()
    if (!approval) {
      throw new Error('Expected a Codex status')
    }
    expect(
      reconcileRemoteCodexState(
        createHookListenerState(),
        PANE_KEY,
        'PermissionRequest',
        undefined,
        approval,
        undefined
      ).state
    ).toBe('working')
    expect(hook('PostToolUse')?.state).toBe('working')
    expect(hook('Stop')?.state).toBe('done')
  })
})
