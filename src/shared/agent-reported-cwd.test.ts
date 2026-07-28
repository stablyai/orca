import { describe, expect, it } from 'vitest'
import {
  AGENT_REPORTED_CWD_MAX_LENGTH,
  extractAgentReportedCwdUpdate,
  mergeAgentReportedCwd,
  normalizeAgentReportedCwdUpdate,
  resolveAcceptedRootReportedCwd,
  validateAgentReportedCwd
} from './agent-reported-cwd'

describe('validateAgentReportedCwd', () => {
  it('accepts trimmed POSIX, drive-rooted, and complete UNC paths', () => {
    expect(validateAgentReportedCwd('  /Users/dev/repo/.claude/worktrees/scratch  ')).toBe(
      '/Users/dev/repo/.claude/worktrees/scratch'
    )
    expect(validateAgentReportedCwd('C:\\repo\\scratch')).toBe('C:\\repo\\scratch')
    expect(validateAgentReportedCwd('D:/repo/scratch')).toBe('D:/repo/scratch')
    expect(validateAgentReportedCwd('\\\\wsl.localhost\\Ubuntu\\home\\dev')).toBe(
      '\\\\wsl.localhost\\Ubuntu\\home\\dev'
    )
    expect(validateAgentReportedCwd('//server/share/repo')).toBe('//server/share/repo')
  })

  it('rejects values that do not name an absolute location', () => {
    expect(validateAgentReportedCwd('')).toBeNull()
    expect(validateAgentReportedCwd('   ')).toBeNull()
    expect(validateAgentReportedCwd('relative/path')).toBeNull()
    // Why: drive-relative and current-drive-relative forms depend on process state.
    expect(validateAgentReportedCwd('C:repo')).toBeNull()
    expect(validateAgentReportedCwd('\\repo\\scratch')).toBeNull()
    expect(validateAgentReportedCwd('//server')).toBeNull()
    expect(validateAgentReportedCwd('\\\\wsl.localhost')).toBeNull()
    expect(validateAgentReportedCwd(`/${'a'.repeat(AGENT_REPORTED_CWD_MAX_LENGTH)}`)).toBeNull()
    expect(validateAgentReportedCwd('/repo/scratch\u0000/etc')).toBeNull()
    expect(validateAgentReportedCwd('/repo/scratch\u007f')).toBeNull()
    expect(validateAgentReportedCwd(42)).toBeNull()
    expect(validateAgentReportedCwd(null)).toBeNull()
    expect(validateAgentReportedCwd({ cwd: '/repo' })).toBeNull()
  })
})

describe('extractAgentReportedCwdUpdate', () => {
  it('reads the native Claude hook cwd from a real-shaped payload', () => {
    const claudeHookBody = {
      session_id: '5f0c3a1e-0000-4a11-9f2b-1a2b3c4d5e6f',
      transcript_path: '/Users/dev/.claude/projects/repo/5f0c3a1e.jsonl',
      cwd: '/Users/dev/repo/.claude/worktrees/10572-live-repro',
      hook_event_name: 'UserPromptSubmit',
      prompt: 'check the sidebar'
    }
    expect(extractAgentReportedCwdUpdate(claudeHookBody)).toBe(
      '/Users/dev/repo/.claude/worktrees/10572-live-repro'
    )
  })

  it('accepts the workspaceRoot aliases and honours alias precedence', () => {
    expect(extractAgentReportedCwdUpdate({ workspaceRoot: '/repo/a' })).toBe('/repo/a')
    expect(extractAgentReportedCwdUpdate({ workspace_root: '/repo/b' })).toBe('/repo/b')
    expect(extractAgentReportedCwdUpdate({ cwd: '/repo/a', workspaceRoot: '/repo/b' })).toBe(
      '/repo/a'
    )
    expect(
      extractAgentReportedCwdUpdate({ workspaceRoot: '/repo/b', workspace_root: '/repo/c' })
    ).toBe('/repo/b')
  })

  it('treats a present-but-invalid preferred alias as a clear, not a fall-through', () => {
    expect(extractAgentReportedCwdUpdate({ cwd: 'relative', workspaceRoot: '/repo/b' })).toBeNull()
    expect(extractAgentReportedCwdUpdate({ cwd: null, workspaceRoot: '/repo/b' })).toBeNull()
  })

  it('treats an absent or unusable payload as absent', () => {
    expect(extractAgentReportedCwdUpdate({ hook_event_name: 'Stop' })).toBeUndefined()
    expect(extractAgentReportedCwdUpdate({ cwd: undefined })).toBeUndefined()
    expect(extractAgentReportedCwdUpdate(undefined)).toBeUndefined()
    expect(extractAgentReportedCwdUpdate(['/repo'])).toBeUndefined()
    expect(extractAgentReportedCwdUpdate('/repo')).toBeUndefined()
  })

  it('reads existing Grok and Hermes payload shapes without a synthesized fallback', () => {
    // Why: neither provider reports a cwd today, so their events must preserve.
    expect(
      extractAgentReportedCwdUpdate({
        event: 'assistant_message',
        session_id: 'grok-1',
        message: 'done'
      })
    ).toBeUndefined()
    expect(
      extractAgentReportedCwdUpdate({ hook_event_name: 'SessionStart', source: 'startup' })
    ).toBeUndefined()
  })
})

describe('mergeAgentReportedCwd', () => {
  it('preserves on absent, replaces on valid, and clears on invalid', () => {
    expect(mergeAgentReportedCwd('/repo/a', undefined)).toBe('/repo/a')
    expect(mergeAgentReportedCwd('/repo/a', '/repo/b')).toBe('/repo/b')
    expect(mergeAgentReportedCwd('/repo/a', null)).toBeUndefined()
    expect(mergeAgentReportedCwd('/repo/a', 'relative' as unknown as string)).toBeUndefined()
    expect(mergeAgentReportedCwd(undefined, undefined)).toBeUndefined()
  })
})

describe('resolveAcceptedRootReportedCwd', () => {
  it('ignores nested child traffic inherited from a live root pane', () => {
    expect(
      resolveAcceptedRootReportedCwd({
        previous: '/repo/a',
        update: '/repo/child',
        inheritedFromActivePane: true,
        rootAgentChanged: false
      })
    ).toBe('/repo/a')
  })

  it('clears the cached location when a different root agent takes the pane', () => {
    expect(
      resolveAcceptedRootReportedCwd({
        previous: '/repo/a',
        update: undefined,
        inheritedFromActivePane: false,
        rootAgentChanged: true
      })
    ).toBeUndefined()
    expect(
      resolveAcceptedRootReportedCwd({
        previous: '/repo/a',
        update: '/repo/b',
        inheritedFromActivePane: false,
        rootAgentChanged: true
      })
    ).toBe('/repo/b')
  })

  it('preserves across same-root transitions that carry no cwd', () => {
    expect(
      resolveAcceptedRootReportedCwd({
        previous: '/repo/a',
        update: undefined,
        inheritedFromActivePane: false,
        rootAgentChanged: false
      })
    ).toBe('/repo/a')
  })
})

describe('normalizeAgentReportedCwdUpdate', () => {
  it('re-validates transport values back into the tri-state domain', () => {
    expect(normalizeAgentReportedCwdUpdate(undefined)).toBeUndefined()
    expect(normalizeAgentReportedCwdUpdate('/repo/a')).toBe('/repo/a')
    expect(normalizeAgentReportedCwdUpdate(null)).toBeNull()
    expect(normalizeAgentReportedCwdUpdate('../escape')).toBeNull()
    expect(normalizeAgentReportedCwdUpdate({ cwd: '/repo/a' })).toBeNull()
  })
})
