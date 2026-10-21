import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createHookListenerState,
  type HookListenerState
} from './agent-hook-listener/listener-state'
import { normalizeHookPayload } from './agent-hook-listener'
import { PANE_KEY } from './agent-hook-listener-test-harness'

/**
 * Codex runs its `PermissionRequest` hook as decider #1, ahead of its own review agent and ahead
 * of the user, so the event alone never means a human is blocked. These pin which approvals stay
 * "Needs You" and which read as ongoing work (STA-7698).
 */
describe('Codex approval ownership', () => {
  let state: HookListenerState
  const dirs: string[] = []

  beforeEach(() => {
    state = createHookListenerState()
  })

  afterEach(() => {
    while (dirs.length > 0) {
      rmSync(dirs.pop()!, { recursive: true, force: true })
    }
  })

  /** Writes a rollout carrying one `turn_context`, optionally naming a reviewer. */
  function writeRollout(options: { reviewer?: string; fileName?: string }): string {
    const root = mkdtempSync(join(tmpdir(), 'codex-approval-ownership-'))
    dirs.push(root)
    const dayDir = join(root, '2026', '09', '17')
    mkdirSync(dayDir, { recursive: true })
    const path = join(dayDir, options.fileName ?? 'rollout-session.jsonl')
    writeFileSync(
      path,
      `${JSON.stringify({
        type: 'turn_context',
        payload: {
          cwd: '/repo',
          model: 'gpt-5-codex',
          approval_policy: 'on-request',
          ...(options.reviewer === undefined ? {} : { approvals_reviewer: options.reviewer })
        }
      })}\n`
    )
    return path
  }

  function appendRollout(path: string, value: unknown): void {
    appendFileSync(path, `${JSON.stringify(value)}\n`)
  }

  function post(payload: Record<string, unknown>): ReturnType<typeof normalizeHookPayload> {
    return normalizeHookPayload(state, 'codex', { paneKey: PANE_KEY, payload }, 'production')
  }

  function permissionRequest(transcriptPath: string): ReturnType<typeof normalizeHookPayload> {
    return post({
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      transcript_path: transcriptPath
    })
  }

  function childPermissionRequest(transcriptPath: string): ReturnType<typeof normalizeHookPayload> {
    return post({
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      transcript_path: transcriptPath,
      agent_id: 'child-after-relay-restart',
      agent_type: 'worker'
    })
  }

  function childPostToolUse(): ReturnType<typeof normalizeHookPayload> {
    return post({
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      agent_id: 'child-after-relay-restart',
      agent_type: 'worker'
    })
  }

  it('reads an auto-reviewed approval as ongoing work, not as needing the user', () => {
    const transcriptPath = writeRollout({ reviewer: 'auto_review' })

    expect(permissionRequest(transcriptPath)?.payload.state).toBe('working')
  })

  it('keeps a user-reviewed approval waiting', () => {
    const transcriptPath = writeRollout({ reviewer: 'user' })

    expect(permissionRequest(transcriptPath)?.payload.state).toBe('waiting')
  })

  it('reconciles reviewer ownership before a child-first auto-reviewed approval', () => {
    const transcriptPath = writeRollout({ reviewer: 'auto_review' })

    expect(childPermissionRequest(transcriptPath)?.payload.state).toBe('working')
  })

  it('keeps a child-first manual approval waiting after reviewer reconciliation', () => {
    const transcriptPath = writeRollout({ reviewer: 'user' })

    expect(childPermissionRequest(transcriptPath)?.payload.state).toBe('waiting')
  })

  it('keeps the parent reviewer after a child with a different reviewer is observed', () => {
    const parentPath = writeRollout({ reviewer: 'auto_review', fileName: 'rollout-parent.jsonl' })
    const childPath = writeRollout({ reviewer: 'user', fileName: 'rollout-child.jsonl' })

    expect(permissionRequest(parentPath)?.payload.state).toBe('working')
    expect(childPermissionRequest(childPath)?.payload.state).toBe('waiting')
    expect(childPostToolUse()?.payload.state).toBe('working')
    expect(permissionRequest(parentPath)?.payload.state).toBe('working')
  })

  it('does not clear a readable parent reviewer when a child rollout is unavailable', () => {
    const parentPath = writeRollout({ reviewer: 'auto_review', fileName: 'rollout-parent.jsonl' })
    const childRoot = mkdtempSync(join(tmpdir(), 'codex-approval-ownership-child-'))
    dirs.push(childRoot)

    expect(permissionRequest(parentPath)?.payload.state).toBe('working')
    expect(childPermissionRequest(join(childRoot, 'missing-child.jsonl'))?.payload.state).toBe(
      'waiting'
    )
    expect(childPostToolUse()?.payload.state).toBe('working')
    expect(permissionRequest(parentPath)?.payload.state).toBe('working')
  })

  it('follows a thread settings update that switches the reviewer back to the user', () => {
    const transcriptPath = writeRollout({ reviewer: 'auto_review' })
    expect(permissionRequest(transcriptPath)?.payload.state).toBe('working')

    appendRollout(transcriptPath, {
      type: 'event_msg',
      payload: {
        type: 'thread_settings_applied',
        thread_settings: { approvals_reviewer: 'user' }
      }
    })

    expect(permissionRequest(transcriptPath)?.payload.state).toBe('waiting')
  })

  it('accepts Codex’s legacy guardian_subagent reviewer spelling as auto review', () => {
    const transcriptPath = writeRollout({ reviewer: 'guardian_subagent' })

    expect(permissionRequest(transcriptPath)?.payload.state).toBe('working')
  })

  it('keeps waiting when the rollout names no reviewer, as older Codex builds do not', () => {
    const transcriptPath = writeRollout({})

    expect(permissionRequest(transcriptPath)?.payload.state).toBe('waiting')
  })

  it('keeps waiting when the rollout cannot be read at all', () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-approval-ownership-'))
    dirs.push(root)

    expect(permissionRequest(join(root, 'absent.jsonl'))?.payload.state).toBe('waiting')
  })

  it('does not retain auto review when a later rollout read is unreadable', () => {
    const transcriptPath = writeRollout({ reviewer: 'auto_review' })
    expect(permissionRequest(transcriptPath)?.payload.state).toBe('working')

    rmSync(transcriptPath)

    expect(permissionRequest(transcriptPath)?.payload.state).toBe('waiting')
  })

  it('keeps waiting when no transcript path is supplied', () => {
    expect(post({ hook_event_name: 'PermissionRequest', tool_name: 'Bash' })?.payload.state).toBe(
      'waiting'
    )
  })

  it('still waits on request_user_input under auto review, which no reviewer can answer', () => {
    const transcriptPath = writeRollout({ reviewer: 'auto_review' })
    permissionRequest(transcriptPath)

    const question = post({
      hook_event_name: 'PreToolUse',
      tool_name: 'request_user_input',
      transcript_path: transcriptPath
    })

    expect(question?.payload.state).toBe('waiting')
  })

  it('does not carry one session’s reviewer into the next rollout', () => {
    const autoReviewed = writeRollout({
      reviewer: 'auto_review',
      fileName: 'rollout-first.jsonl'
    })
    expect(permissionRequest(autoReviewed)?.payload.state).toBe('working')

    const unstated = writeRollout({ fileName: 'rollout-second.jsonl' })

    expect(permissionRequest(unstated)?.payload.state).toBe('waiting')
  })

  it('leaves the surrounding turn working, so an auto-reviewed turn never flaps', () => {
    const transcriptPath = writeRollout({ reviewer: 'auto_review' })
    const states = [
      post({
        hook_event_name: 'UserPromptSubmit',
        prompt: 'ship it',
        transcript_path: transcriptPath
      }),
      post({
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        transcript_path: transcriptPath
      }),
      permissionRequest(transcriptPath),
      post({
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        transcript_path: transcriptPath
      })
    ].map((event) => event?.payload.state)

    expect(states).toEqual(['working', 'working', 'working', 'working'])
  })
})
