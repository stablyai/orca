import { describe, expect, it } from 'vitest'
import {
  hasUnsupportedTuiAgentArgs,
  normalizeTuiAgentArgsRecord,
  resolveTuiAgentLaunchArgs
} from './tui-agent-launch-defaults'
import { YOLO_TUI_AGENT_ARGS } from './tui-agent-permissions'

describe('tui agent launch defaults', () => {
  it('defaults Cursor YOLO to --force', () => {
    expect(YOLO_TUI_AGENT_ARGS.cursor).toBe('--force')
    expect(resolveTuiAgentLaunchArgs('cursor', undefined)).toBe('--force')
  })

  it('rewrites persisted Cursor --yolo to --force and keeps extra args', () => {
    expect(
      normalizeTuiAgentArgsRecord({
        cursor: '--yolo --model auto'
      })
    ).toEqual({
      cursor: '--force --model auto'
    })
  })

  it('treats persisted Cursor --yolo as stale so load can persist the rewrite', () => {
    expect(hasUnsupportedTuiAgentArgs('cursor', '--yolo')).toBe(true)
    expect(hasUnsupportedTuiAgentArgs('cursor', '--force')).toBe(false)
    expect(hasUnsupportedTuiAgentArgs('cursor', '--yolo --model auto')).toBe(true)
  })

  it('still strips OpenCode skip-permissions without rewriting Cursor', () => {
    expect(
      normalizeTuiAgentArgsRecord({
        opencode: '--dangerously-skip-permissions --model opencode/gpt-5',
        cursor: '--force'
      })
    ).toEqual({
      opencode: '--model opencode/gpt-5',
      cursor: '--force'
    })
  })
})
