import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  fetchIssueContent,
  injectIssueContentIntoAgent,
  resolveInjectionDecision
} from './inject-issue-content'
import type { Worktree } from '../../../shared/types'

const testState = vi.hoisted(() => ({
  getActiveRuntimeTarget: vi.fn(),
  callRuntimeRpc: vi.fn(),
  buildContainedLinkedContextBlock: vi.fn(),
  pasteDraftWhenAgentReady: vi.fn(),
  linearGetIssue: vi.fn(),
  ghWorkItemDetails: vi.fn()
}))

vi.mock('@/runtime/runtime-rpc-client', () => ({
  getActiveRuntimeTarget: testState.getActiveRuntimeTarget,
  callRuntimeRpc: testState.callRuntimeRpc
}))

vi.mock('@/lib/linked-work-item-context', () => ({
  buildContainedLinkedContextBlock: testState.buildContainedLinkedContextBlock
}))

vi.mock('@/lib/agent-paste-draft', () => ({
  pasteDraftWhenAgentReady: testState.pasteDraftWhenAgentReady
}))

function makeWorktree(overrides?: Partial<Worktree>): Worktree {
  return {
    id: 'repo-1::/path/to/wt',
    repoId: 'repo-1',
    displayName: 'test-worktree',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: Date.now(),
    ...overrides
  } as Worktree
}

describe('resolveInjectionDecision', () => {
  it('respects worktree override when true', () => {
    expect(resolveInjectionDecision('never', true)).toBe('inject')
  })

  it('respects worktree override when false', () => {
    expect(resolveInjectionDecision('always', false)).toBe('skip')
  })

  it('defaults to inject when preference is always', () => {
    expect(resolveInjectionDecision('always', undefined)).toBe('inject')
  })

  it('defaults to inject when preference is undefined', () => {
    expect(resolveInjectionDecision(undefined, undefined)).toBe('inject')
  })

  it('returns skip when preference is never', () => {
    expect(resolveInjectionDecision('never', undefined)).toBe('skip')
  })

  it('returns ask when preference is ask', () => {
    expect(resolveInjectionDecision('ask', undefined)).toBe('ask')
  })
})

describe('fetchIssueContent', () => {
  beforeEach(() => {
    testState.getActiveRuntimeTarget.mockReset()
    testState.callRuntimeRpc.mockReset()
    testState.linearGetIssue.mockReset()
    testState.ghWorkItemDetails.mockReset()

    testState.getActiveRuntimeTarget.mockReturnValue({ kind: 'local' })

    vi.stubGlobal('window', {
      api: {
        linear: { getIssue: testState.linearGetIssue },
        gh: { workItemDetails: testState.ghWorkItemDetails }
      }
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  describe('Linear issues', () => {
    it('fetches Linear issue content via local runtime', async () => {
      testState.linearGetIssue.mockResolvedValue({
        id: 'issue-1',
        identifier: 'ENG-123',
        title: 'Fix the bug',
        description: 'Detailed description here',
        url: 'https://linear.app/issue/ENG-123'
      })

      const worktree = makeWorktree({ linkedLinearIssue: 'issue-1' })
      const result = await fetchIssueContent({
        worktree,
        settings: {}
      })

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.content.provider).toBe('linear')
        expect(result.content.renderedText).toBe('Fix the bug\n\nDetailed description here')
      }
      expect(testState.linearGetIssue).toHaveBeenCalledWith({ id: 'issue-1' })
    })

    it('fetches Linear issue content via remote runtime', async () => {
      testState.getActiveRuntimeTarget.mockReturnValue({
        kind: 'environment',
        environmentId: 'env-1'
      })
      testState.callRuntimeRpc.mockResolvedValue({
        id: 'issue-1',
        identifier: 'ENG-123',
        title: 'Fix the bug',
        description: 'Detailed description here',
        url: 'https://linear.app/issue/ENG-123'
      })

      const worktree = makeWorktree({ linkedLinearIssue: 'issue-1' })
      const result = await fetchIssueContent({
        worktree,
        settings: { activeRuntimeEnvironmentId: 'env-1' }
      })

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.content.provider).toBe('linear')
        expect(result.content.renderedText).toBe('Fix the bug\n\nDetailed description here')
      }
      expect(testState.callRuntimeRpc).toHaveBeenCalledWith(
        { kind: 'environment', environmentId: 'env-1' },
        'linear.getIssue',
        { id: 'issue-1' }
      )
    })

    it('returns error when Linear issue is not found', async () => {
      testState.linearGetIssue.mockResolvedValue(null)

      const worktree = makeWorktree({ linkedLinearIssue: 'missing-id' })
      const result = await fetchIssueContent({
        worktree,
        settings: {}
      })

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error).toContain('not found')
      }
    })

    it('handles Linear issues with no description', async () => {
      testState.linearGetIssue.mockResolvedValue({
        id: 'issue-1',
        identifier: 'ENG-123',
        title: 'Fix the bug',
        url: 'https://linear.app/issue/ENG-123'
      })

      const worktree = makeWorktree({ linkedLinearIssue: 'issue-1' })
      const result = await fetchIssueContent({
        worktree,
        settings: {}
      })

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.content.renderedText).toBe('Fix the bug\n\n')
      }
    })
  })

  describe('GitHub issues', () => {
    it('fetches GitHub issue content via local runtime', async () => {
      testState.ghWorkItemDetails.mockResolvedValue({
        item: { number: 42, title: 'Fix the bug', url: 'https://github.com/org/repo/issues/42' },
        body: 'Detailed description here',
        comments: []
      })

      const worktree = makeWorktree({ linkedIssue: 42 })
      const result = await fetchIssueContent({
        worktree,
        settings: {},
        repoPath: '/path/to/repo'
      })

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.content.provider).toBe('github')
        expect(result.content.renderedText).toBe('Fix the bug\n\nDetailed description here')
      }
      expect(testState.ghWorkItemDetails).toHaveBeenCalledWith({
        repoPath: '/path/to/repo',
        repoId: 'repo-1',
        number: 42,
        type: 'issue'
      })
    })

    it('fetches GitHub issue content via remote runtime', async () => {
      testState.getActiveRuntimeTarget.mockReturnValue({
        kind: 'environment',
        environmentId: 'env-1'
      })
      testState.callRuntimeRpc.mockResolvedValue({
        item: { number: 42, title: 'Fix the bug', url: 'https://github.com/org/repo/issues/42' },
        body: 'Detailed description here',
        comments: []
      })

      const worktree = makeWorktree({ linkedIssue: 42 })
      const result = await fetchIssueContent({
        worktree,
        settings: { activeRuntimeEnvironmentId: 'env-1' },
        repoPath: '/path/to/repo'
      })

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.content.provider).toBe('github')
      }
      expect(testState.callRuntimeRpc).toHaveBeenCalledWith(
        { kind: 'environment', environmentId: 'env-1' },
        'github.workItemDetails',
        { repo: 'repo-1', number: 42, type: 'issue' }
      )
    })

    it('returns error when repoPath is missing for GitHub issue', async () => {
      const worktree = makeWorktree({ linkedIssue: 42 })
      const result = await fetchIssueContent({
        worktree,
        settings: {}
      })

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error).toContain('repoPath is required')
      }
    })

    it('returns error when GitHub issue is not found', async () => {
      testState.ghWorkItemDetails.mockResolvedValue(null)

      const worktree = makeWorktree({ linkedIssue: 42 })
      const result = await fetchIssueContent({
        worktree,
        settings: {},
        repoPath: '/path/to/repo'
      })

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error).toContain('not found')
      }
    })

    it('handles GitHub issues with no body', async () => {
      testState.ghWorkItemDetails.mockResolvedValue({
        item: { number: 42, title: 'Fix the bug', url: 'https://github.com/org/repo/issues/42' },
        body: null,
        comments: []
      })

      const worktree = makeWorktree({ linkedIssue: 42 })
      const result = await fetchIssueContent({
        worktree,
        settings: {},
        repoPath: '/path/to/repo'
      })

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.content.renderedText).toBe('Fix the bug\n\n')
      }
    })
  })

  describe('No linked issue', () => {
    it('returns error when worktree has no linked issue', async () => {
      const worktree = makeWorktree()
      const result = await fetchIssueContent({
        worktree,
        settings: {}
      })

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error).toContain('No linked issue')
      }
    })
  })

  describe('Error handling', () => {
    it('returns error when fetch throws', async () => {
      testState.linearGetIssue.mockRejectedValue(new Error('Network error'))

      const worktree = makeWorktree({ linkedLinearIssue: 'issue-1' })
      const result = await fetchIssueContent({
        worktree,
        settings: {}
      })

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error).toContain('Network error')
      }
    })

    it('returns error for non-Error exceptions', async () => {
      testState.linearGetIssue.mockRejectedValue('string error')

      const worktree = makeWorktree({ linkedLinearIssue: 'issue-1' })
      const result = await fetchIssueContent({
        worktree,
        settings: {}
      })

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error).toContain('string error')
      }
    })
  })
})

describe('injectIssueContentIntoAgent', () => {
  beforeEach(() => {
    testState.buildContainedLinkedContextBlock.mockReset()
    testState.pasteDraftWhenAgentReady.mockReset()
  })

  it('injects formatted content successfully', async () => {
    testState.buildContainedLinkedContextBlock.mockReturnValue('formatted content')
    testState.pasteDraftWhenAgentReady.mockResolvedValue(true)

    const result = await injectIssueContentIntoAgent({
      tabId: 'tab-1',
      content: {
        provider: 'linear',
        version: 1,
        renderedText: 'Issue title\n\nDescription'
      }
    })

    expect(result.success).toBe(true)
    expect(testState.pasteDraftWhenAgentReady).toHaveBeenCalledWith({
      tabId: 'tab-1',
      content: 'formatted content',
      agent: undefined,
      submit: false,
      timeoutMs: 10000,
      onTimeout: expect.any(Function)
    })
  })

  it('returns error when formatting fails', async () => {
    testState.buildContainedLinkedContextBlock.mockReturnValue(null)

    const result = await injectIssueContentIntoAgent({
      tabId: 'tab-1',
      content: {
        provider: 'linear',
        version: 1,
        renderedText: 'Issue title\n\nDescription'
      }
    })

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toContain('Failed to format')
    }
    expect(testState.pasteDraftWhenAgentReady).not.toHaveBeenCalled()
  })

  it('returns error when paste fails', async () => {
    testState.buildContainedLinkedContextBlock.mockReturnValue('formatted content')
    testState.pasteDraftWhenAgentReady.mockResolvedValue(false)

    const result = await injectIssueContentIntoAgent({
      tabId: 'tab-1',
      content: {
        provider: 'linear',
        version: 1,
        renderedText: 'Issue title\n\nDescription'
      },
      agent: 'claude'
    })

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toContain('agent may still be starting')
    }
  })
})
