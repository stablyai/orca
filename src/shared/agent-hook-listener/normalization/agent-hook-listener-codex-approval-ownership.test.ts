import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHookListenerState, type HookListenerState } from '../listener-state'
import { normalizeHookPayload } from './normalize-hook-payload'
import { PANE_KEY } from './agent-hook-listener-test-harness'

/** Codex PermissionRequest precedes its reviewer/user decisions; the event alone cannot claim a human is blocked (STA-7698). */
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

  it('keeps the parent reviewer after a child with a different reviewer is observed', () => {
    const parentPath = writeRollout({ reviewer: 'auto_review', fileName: 'rollout-parent.jsonl' })
    const childPath = writeRollout({ reviewer: 'user', fileName: 'rollout-child.jsonl' })

    expect(permissionRequest(parentPath)?.payload.state).toBe('working')
    expect(childPermissionRequest(childPath)?.payload.state).toBe('waiting')
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

  it('does not retain auto review when a later rollout read is unreadable', () => {
    const transcriptPath = writeRollout({ reviewer: 'auto_review' })
    expect(permissionRequest(transcriptPath)?.payload.state).toBe('working')

    rmSync(transcriptPath)

    expect(permissionRequest(transcriptPath)?.payload.state).toBe('waiting')
  })
})
