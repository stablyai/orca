import { describe, expect, it } from 'vitest'
import {
  isWorkspacePopoutDockArgs,
  isWorkspacePopoutTarget,
  validateWorkspacePopoutTarget,
  WORKSPACE_POPOUT_ID_MAX_LENGTH,
  WORKSPACE_POPOUT_TITLE_MAX_LENGTH,
  type WorkspacePopoutTarget
} from './workspace-popout-contract'

describe('workspace-popout-contract', () => {
  const validTarget: WorkspacePopoutTarget = {
    worktreeId: 'wt-123',
    tabId: 'tab-abc',
    ptyId: 'pty-456',
    terminalInput: null,
    title: 'Terminal 1'
  }

  it('accepts a valid popout target', () => {
    expect(isWorkspacePopoutTarget(validTarget)).toBe(true)
    const result = validateWorkspacePopoutTarget(validTarget)
    expect(result.valid).toBe(true)
    if (result.valid) {
      expect(result.target).toEqual(validTarget)
    }
  })

  it('accepts target with valid terminalInput object', () => {
    const targetWithInput = {
      ...validTarget,
      terminalInput: {
        isWindowsPty: false,
        supportsConPtyEscapedEnter: false,
        isMacAppPaste: false
      }
    }
    expect(isWorkspacePopoutTarget(targetWithInput)).toBe(true)
  })

  it('rejects missing or null target', () => {
    expect(isWorkspacePopoutTarget(null)).toBe(false)
    expect(isWorkspacePopoutTarget(undefined)).toBe(false)
    expect(isWorkspacePopoutTarget('not-an-object')).toBe(false)
    expect(validateWorkspacePopoutTarget(null)).toEqual({
      valid: false,
      reason: 'invalid-payload'
    })
  })

  it('rejects missing fields', () => {
    expect(isWorkspacePopoutTarget({ tabId: 'tab', ptyId: 'pty', title: '' })).toBe(false)
    expect(isWorkspacePopoutTarget({ worktreeId: 'wt', ptyId: 'pty', title: '' })).toBe(false)
    expect(isWorkspacePopoutTarget({ worktreeId: 'wt', tabId: 'tab', title: '' })).toBe(false)
  })

  it('rejects empty strings for IDs', () => {
    expect(isWorkspacePopoutTarget({ ...validTarget, worktreeId: '' })).toBe(false)
    expect(isWorkspacePopoutTarget({ ...validTarget, tabId: '' })).toBe(false)
    expect(isWorkspacePopoutTarget({ ...validTarget, ptyId: '' })).toBe(false)
  })

  it('rejects IDs exceeding 4096 characters', () => {
    const longId = 'a'.repeat(WORKSPACE_POPOUT_ID_MAX_LENGTH + 1)
    expect(isWorkspacePopoutTarget({ ...validTarget, worktreeId: longId })).toBe(false)
    expect(isWorkspacePopoutTarget({ ...validTarget, tabId: longId })).toBe(false)
    expect(isWorkspacePopoutTarget({ ...validTarget, ptyId: longId })).toBe(false)
  })

  it('rejects title exceeding 256 characters', () => {
    const longTitle = 't'.repeat(WORKSPACE_POPOUT_TITLE_MAX_LENGTH + 1)
    expect(isWorkspacePopoutTarget({ ...validTarget, title: longTitle })).toBe(false)
    expect(validateWorkspacePopoutTarget({ ...validTarget, title: longTitle })).toEqual({
      valid: false,
      reason: 'invalid-payload'
    })
  })

  it('rejects remote runtime PTY IDs with specific reason', () => {
    const remoteTarget = {
      ...validTarget,
      ptyId: 'remote:env-123@@pty-456'
    }
    expect(isWorkspacePopoutTarget(remoteTarget)).toBe(false)
    expect(validateWorkspacePopoutTarget(remoteTarget)).toEqual({
      valid: false,
      reason: 'remote-runtime-pty'
    })
  })

  describe('isWorkspacePopoutDockArgs', () => {
    it('accepts valid dock args', () => {
      expect(isWorkspacePopoutDockArgs({ worktreeId: 'wt-123' })).toBe(true)
    })

    it('rejects invalid dock args', () => {
      expect(isWorkspacePopoutDockArgs(null)).toBe(false)
      expect(isWorkspacePopoutDockArgs({})).toBe(false)
      expect(isWorkspacePopoutDockArgs({ worktreeId: '' })).toBe(false)
      expect(
        isWorkspacePopoutDockArgs({ worktreeId: 'w'.repeat(WORKSPACE_POPOUT_ID_MAX_LENGTH + 1) })
      ).toBe(false)
    })
  })
})
