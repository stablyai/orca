// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { useAppStore } from '@/store'
import type { CommitDraftsByWorktree } from './commit-drafts'

const host = vi.hoisted(() => {
  const held: {
    succeed: ((message: string) => void) | null
    cancel: Mock<() => void>
  } = { succeed: null, cancel: vi.fn<() => void>() }
  return held
})
vi.mock('@/runtime/runtime-git-generation-client', () => ({
  generateRuntimeCommitMessage: () =>
    new Promise((resolve) => {
      host.succeed = (message) => resolve({ success: true, message })
    }),
  cancelRuntimeGenerateCommitMessage: () => host.cancel()
}))
vi.mock('@/lib/connection-context', () => ({ getConnectionId: () => null }))

import { useSourceControlCommitMessageGeneration } from './use-commit-message-generation'

const WORKTREE_ID = 'repo-1::/repo'
const initialAppState = useAppStore.getInitialState()
let drafts: CommitDraftsByWorktree = {}
const generateInFlightRef: { current: Record<string, boolean> } = { current: {} }
let latest: ReturnType<typeof useSourceControlCommitMessageGeneration> | null = null
let root: Root | null = null

function Probe(): null {
  const records = useAppStore((s) => s.commitMessageGenerationRecords)
  const state = useAppStore.getState()
  latest = useSourceControlCommitMessageGeneration({
    activeRepo: null,
    activeRepoTarget: { kind: 'local' },
    activeWorktreeId: WORKTREE_ID,
    allocateCommitMessageGenerationRequestId: state.allocateCommitMessageGenerationRequestId,
    commitMessageGenerationRecords: records,
    generateErrors: {},
    generateInFlightByWorktree: {},
    generateInFlightRef,
    openCommitGenerationDialog: () => {},
    resolvedCommitMessageAi: null,
    setCommitMessageGenerationRecord: state.setCommitMessageGenerationRecord,
    setGenerateErrors: () => {},
    setGenerateInFlightByWorktree: () => {},
    settings: null,
    sourceControlAiActionsVisible: true,
    updateCommitDrafts: (update) => {
      drafts = typeof update === 'function' ? update(drafts) : update
    },
    updateCommitMessageGenerationRecord: state.updateCommitMessageGenerationRecord,
    worktreePath: '/repo'
  })
  return null
}

async function startGenerating(): Promise<{ pending: Promise<void> | undefined }> {
  await act(async () => {
    root = createRoot(document.createElement('div'))
    root.render(createElement(Probe))
  })
  let pending: Promise<void> | undefined
  await act(async () => {
    pending = latest?.handleGenerate({
      sourceControlAiResolvedParams: { agentId: 'claude', model: 'sonnet' }
    })
  })
  return { pending }
}

beforeEach(() => {
  useAppStore.setState({ recordFeatureInteraction: async () => {} })
  drafts = {}
  generateInFlightRef.current = {}
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  latest = null
  host.succeed = null
  host.cancel.mockClear()
  useAppStore.setState(initialAppState, true)
})

describe('a commit message generation that was canceled', () => {
  it('fills the empty box when nothing canceled the run', async () => {
    const { pending } = await startGenerating()
    await act(async () => {
      host.succeed?.('feat: generated')
      await pending
    })
    expect(drafts[WORKTREE_ID]).toBe('feat: generated')
  })

  it('drops the late reply after a cancel, so a commit that emptied the box stays empty', async () => {
    const { pending } = await startGenerating()
    act(() => latest?.handleCancelGenerate())
    expect(host.cancel).toHaveBeenCalledTimes(1)
    await act(async () => {
      host.succeed?.('feat: generated for the old diff')
      await pending
    })
    expect(drafts[WORKTREE_ID]).toBeUndefined()
  })
})
