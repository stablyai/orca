// @vitest-environment happy-dom

import { useRef, useState } from 'react'
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { LinkedWorkItemSummary } from '@/lib/new-workspace'
import { useIssueSourceActions } from './issue-source-actions'
import { useMultipleCreateReset } from './multiple-create-reset'
import type { SmartGitHubPrStartPointSelection } from './source-selection-decisions'

const sources: LinkedWorkItemSummary[] = [
  {
    provider: 'github',
    type: 'pr',
    number: 42,
    title: 'Fix checkout',
    url: 'https://github.com/acme/app/pull/42'
  },
  {
    provider: 'github',
    type: 'issue',
    number: 43,
    title: 'Fix checkout',
    url: 'https://github.com/acme/app/issues/43'
  },
  {
    provider: 'gitlab',
    type: 'mr',
    number: 44,
    title: 'Fix checkout',
    url: 'https://gitlab.com/acme/app/-/merge_requests/44'
  }
]

function useSelectedSourceReset(
  initialItem: LinkedWorkItemSummary | null,
  isProjectGroupTarget = false,
  initialBaseBranch: string | undefined = '1234567890abcdef1234567890abcdef12345678'
) {
  const [linkedWorkItem, setLinkedWorkItem] = useState<LinkedWorkItemSummary | null>(initialItem)
  const [baseBranch, setBaseBranch] = useState<string | undefined>(initialBaseBranch)
  const [name, setName] = useState('fix-checkout')
  const [note, setNote] = useState('User note')
  const lastAutoNameRef = useRef(name)
  const branchAutoNameRef = useRef('fix-checkout')
  const lastAutoNoteRef = useRef('Generated note')
  const smartGitHubPrStartPointSelectionRef = useRef<SmartGitHubPrStartPointSelection | null>(
    initialItem?.provider === 'github' && initialItem.type === 'pr'
      ? {
          repoId: 'repo-1',
          item: {
            ...initialItem,
            type: 'pr',
            id: 'pr-42',
            repoId: 'repo-1',
            state: 'open',
            labels: [],
            updatedAt: '2026-09-01T00:00:00Z',
            author: null
          }
        }
      : null
  )
  const source = useIssueSourceActions({
    baseBranch,
    branchAutoNameRef,
    isProjectGroupTarget,
    lastAutoNameRef,
    lastAutoNoteRef,
    linkedWorkItem,
    name,
    noteRef: useRef(note),
    setBaseBranch,
    setBranchNameOverride: vi.fn(),
    setBranchNameOverridePreservesNameEdits: vi.fn(),
    setCompareBaseRef: vi.fn(),
    setForkPushWarning: vi.fn(),
    setLinkedGitLabIssue: vi.fn(),
    setLinkedGitLabMR: vi.fn(),
    setLinkedIssue: vi.fn(),
    setLinkedPR: vi.fn(),
    setLinkedTaskSourceContext: vi.fn(),
    setLinkedWorkItem,
    setName,
    setNote,
    setPushTarget: vi.fn(),
    setReuseEligibleBranch: vi.fn(),
    setReuseSelectedBranch: vi.fn(),
    setStartFromResetHint: vi.fn(),
    smartGitHubPrStartPointSelectionRef
  })
  const reset = useMultipleCreateReset({
    handleClearSmartNameSelection: source.handleClearSmartNameSelection,
    lastAutoNameRef,
    nameInputRef: useRef(null),
    setAgentPrompt: vi.fn(),
    setAttachmentPaths: vi.fn(),
    setCreateError: vi.fn(),
    setName,
    setNote
  })
  return {
    ...reset,
    selection: source.smartNameSelection,
    linkedWorkItem,
    baseBranch,
    name,
    note,
    branchAutoNameRef,
    smartGitHubPrStartPointSelectionRef
  }
}

describe('create more source reset', () => {
  it.each(sources)(
    'clears $provider $type and its checkout source before the next create',
    (item) => {
      const { result } = renderHook(() => useSelectedSourceReset(item))
      expect(result.current.selection?.label).toContain('Fix checkout')

      if (item.provider === 'github' && item.type === 'pr') {
        expect(result.current.smartGitHubPrStartPointSelectionRef.current).not.toBeNull()
      }

      act(() => result.current.resetForNextCreate())

      expect(result.current.smartGitHubPrStartPointSelectionRef.current).toBeNull()
      expect(result.current.selection).toBeNull()
      expect(result.current.linkedWorkItem).toBeNull()
      expect(result.current.baseBranch).toBeUndefined()
      expect(result.current.name).toBe('')
      expect(result.current.note).toBe('')
      expect(result.current.branchAutoNameRef.current).toBe('')
    }
  )

  it.each(['linear', 'jira'] as const)('clears a %s task on a folder target', (provider) => {
    const item: LinkedWorkItemSummary = {
      provider,
      type: 'issue',
      number: 0,
      title: 'Fix checkout',
      url:
        provider === 'linear'
          ? 'https://linear.app/acme/issue/APP-45'
          : 'https://acme.atlassian.net/browse/APP-45'
    }
    const { result } = renderHook(() => useSelectedSourceReset(item, true))
    expect(result.current.selection?.kind).toBe(provider)

    act(() => result.current.resetForNextCreate())

    expect(result.current.selection).toBeNull()
    expect(result.current.linkedWorkItem).toBeNull()
    expect(result.current.name).toBe('')
    expect(result.current.note).toBe('')
  })

  it('clears a plain branch selection before the next create', () => {
    const { result } = renderHook(() => useSelectedSourceReset(null, false, 'feature/checkout'))
    expect(result.current.selection).toEqual({ kind: 'branch', label: 'feature/checkout' })

    act(() => result.current.resetForNextCreate())

    expect(result.current.selection).toBeNull()
    expect(result.current.baseBranch).toBeUndefined()
  })
})
