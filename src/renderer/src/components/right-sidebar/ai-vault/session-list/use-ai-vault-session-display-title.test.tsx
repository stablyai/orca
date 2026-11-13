// @vitest-environment happy-dom
import { acceptedAgentStatuses } from '@/store/slices/agent-status/accepted-agent-statuses'

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { AiVaultSession } from '../../../../../../shared/ai-vault/contracts/ai-vault-types'
import { makePaneKey } from '../../../../../../shared/workspace-layout/stable-pane-id'
import { useAppStore } from '@/store/index'
import {
  buildAiVaultOriginalPaneIndex,
  findOriginalAiVaultSessionPaneInIndex
} from '../session-actions/ai-vault-original-pane-index'
import { useAiVaultSessionDisplayTitle } from './use-ai-vault-session-display-title'

const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const WORKTREE_ID = 'repo-1::/folder'
const initialState = useAppStore.getInitialState()

const session: AiVaultSession = {
  id: 'local:claude-1',
  executionHostId: 'local',
  agent: 'claude',
  sessionId: 'claude-1',
  title: 'Original prompt',
  cwd: '/folder',
  branch: null,
  model: null,
  filePath: '/sessions/claude-1.jsonl',
  codexHome: null,
  createdAt: null,
  updatedAt: null,
  modifiedAt: '2026-10-06T00:00:00Z',
  messageCount: 1,
  totalTokens: 0,
  previewMessages: [],
  queuedMessageCount: 0,
  subagentTranscriptCount: 0,
  resumeCommand: 'claude --resume claude-1',
  subagent: null
}

function setTabTitle(customTitle: string | null): void {
  useAppStore.setState({
    tabsByWorktree: {
      [WORKTREE_ID]: [
        {
          id: 'tab-1',
          ptyId: 'pty-1',
          worktreeId: WORKTREE_ID,
          title: 'Terminal 1',
          customTitle,
          color: null,
          sortOrder: 0,
          createdAt: 0
        }
      ]
    }
  })
}

function seedOpenPane(knownLocalRepo: boolean): void {
  const paneKey = makePaneKey('tab-1', LEAF_ID)
  useAppStore.setState({
    repos: knownLocalRepo
      ? [
          {
            id: 'repo-1',
            path: '/folder',
            displayName: 'folder',
            badgeColor: '#000000',
            addedAt: 0
          }
        ]
      : [],
    agentStatusByPaneKey: acceptedAgentStatuses([
      [
        paneKey,
        {
          state: 'working',
          prompt: 'Original prompt',
          updatedAt: 1,
          stateStartedAt: 1,
          agentType: 'claude',
          paneKey,
          tabId: 'tab-1',
          worktreeId: WORKTREE_ID,
          stateHistory: [],
          providerSession: { key: 'session_id', id: 'claude-1' }
        }
      ]
    ]),
    terminalLayoutsByTabId: {
      'tab-1': {
        root: { type: 'leaf', leafId: LEAF_ID },
        activeLeafId: LEAF_ID,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF_ID]: 'pty-1' }
      }
    }
  })
}

afterEach(() => {
  cleanup()
  useAppStore.setState(initialState, true)
})

describe('useAiVaultSessionDisplayTitle for terminal sessions', () => {
  it('follows the owning tab rename on the same host and falls back to the transcript title', () => {
    seedOpenPane(true)
    setTabTitle(null)
    const target = findOriginalAiVaultSessionPaneInIndex(
      buildAiVaultOriginalPaneIndex(useAppStore.getState()),
      session
    )
    const { result } = renderHook(() => useAiVaultSessionDisplayTitle(session, target))
    const remoteSession: AiVaultSession = { ...session, executionHostId: 'ssh:box' }
    const remote = renderHook(() => useAiVaultSessionDisplayTitle(remoteSession, target))
    expect(result.current).toBe('Original prompt')

    act(() => setTabTitle('  My rename '))
    expect(result.current).toBe('My rename')
    expect(remote.result.current).toBe('Original prompt')

    act(() => setTabTitle(null))
    expect(result.current).toBe('Original prompt')
  })

  it('does not treat an unhydrated or unknown worktree as local', () => {
    seedOpenPane(false)
    setTabTitle('Orphaned remote tab rename')
    const target = findOriginalAiVaultSessionPaneInIndex(
      buildAiVaultOriginalPaneIndex(useAppStore.getState()),
      session
    )
    const { result } = renderHook(() => useAiVaultSessionDisplayTitle(session, target))
    expect(result.current).toBe('Original prompt')
  })
})
