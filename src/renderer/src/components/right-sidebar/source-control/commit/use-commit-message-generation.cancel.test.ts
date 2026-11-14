// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { useAppStore } from '@/store'
import type { Repo } from '../../../../../../shared/repo-types'
import { getDefaultSettings } from '../../../../../../shared/constants'
import { normalizeSourceControlAiSettings } from '../../../../../../shared/source-control/ai/settings/source-control-ai-settings'
import {
  getWorktreeOperationStore,
  writeWorktreeCommitDraft
} from '../panel/worktree-operation-store'

const host = vi.hoisted(() => {
  const held: {
    succeed: ((message: string) => void) | null
    cancel: Mock<() => void>
    overrides: unknown
  } = { succeed: null, cancel: vi.fn<() => void>(), overrides: undefined }
  return held
})
vi.mock('@/runtime/source-control/git/runtime-git-generation-client', () => ({
  generateRuntimeCommitMessage: (_context: unknown, overrides: unknown) =>
    new Promise((resolve) => {
      host.overrides = overrides
      host.succeed = (message) => resolve({ success: true, message })
    }),
  cancelRuntimeGenerateCommitMessage: () => host.cancel()
}))
vi.mock('@/lib/workspace/ownership/connection-context', () => ({ getConnectionId: () => null }))

import { useSourceControlCommitMessageGeneration } from './use-commit-message-generation'

const WORKTREE_ID = 'repo-1::/repo'
const initialAppState = useAppStore.getInitialState()
const operationStore = getWorktreeOperationStore(WORKTREE_ID, null, undefined)
let activeRepo: Repo | null = null
let latest: ReturnType<typeof useSourceControlCommitMessageGeneration> | null = null
let root: Root | null = null

function Probe(): null {
  const state = useAppStore.getState()
  latest = useSourceControlCommitMessageGeneration({
    activeRepo,
    activeRepoTarget: { kind: 'local' },
    activeWorktreeId: WORKTREE_ID,
    allocateCommitMessageGenerationRequestId: state.allocateCommitMessageGenerationRequestId,
    openCommitGenerationDialog: () => {},
    operationStore,
    setCommitMessageGenerationRecord: state.setCommitMessageGenerationRecord,
    updateCommitDraft: (update) => writeWorktreeCommitDraft(operationStore, update),
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
  writeWorktreeCommitDraft(operationStore, '')
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  latest = null
  activeRepo = null
  host.succeed = null
  host.overrides = undefined
  host.cancel.mockClear()
  useAppStore.setState(initialAppState, true)
})

describe('a commit message generation that was canceled', () => {
  it('drops the late reply after a cancel, so a commit that emptied the box stays empty', async () => {
    const { pending } = await startGenerating()
    act(() => latest?.handleCancelGenerate())
    expect(host.cancel).toHaveBeenCalledTimes(1)
    await act(async () => {
      host.succeed?.('feat: generated for the old diff')
      await pending
    })
    expect(operationStore.getState().draft).toBe('')
  })
})

describe('a commit message generated from a local repo', () => {
  it('runs the model picked for this machine', async () => {
    activeRepo = {
      id: 'repo-1',
      path: '/repo',
      displayName: 'repo',
      badgeColor: '#000000',
      addedAt: 0,
      connectionId: null
    }
    useAppStore.setState({
      settings: {
        ...getDefaultSettings('/home/user'),
        sourceControlAi: {
          ...normalizeSourceControlAiSettings(undefined),
          enabled: true,
          agentId: 'codex',
          selectedModelByAgent: { codex: 'gpt-5.5' }
        }
      }
    })
    await act(async () => {
      root = createRoot(document.createElement('div'))
      root.render(createElement(Probe))
    })
    act(() => latest?.handleGenerateCommitMessageClick())
    expect(host.overrides).toMatchObject({
      sourceControlAiResolvedParams: { agentId: 'codex', model: 'gpt-5.5' }
    })
  })
})
