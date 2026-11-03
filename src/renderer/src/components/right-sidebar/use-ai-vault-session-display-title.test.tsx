// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import { useAppStore } from '@/store'

vi.mock('./ai-vault-original-pane', () => ({
  findOriginalAiVaultSessionPane: () => ({
    paneKey: 'tab-1:leaf',
    worktreeId: 'w1',
    tabId: 'tab-1',
    leafId: 'leaf'
  })
}))

import { useAiVaultSessionDisplayTitle } from './use-ai-vault-session-display-title'

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
      w1: [
        {
          id: 'tab-1',
          ptyId: null,
          worktreeId: 'w1',
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

afterEach(() => {
  cleanup()
  useAppStore.setState(initialState, true)
})

describe('useAiVaultSessionDisplayTitle for terminal sessions', () => {
  it('follows the owning tab rename and falls back to the transcript title', () => {
    setTabTitle(null)
    const { result } = renderHook(() => useAiVaultSessionDisplayTitle(session))
    expect(result.current).toBe('Original prompt')

    act(() => setTabTitle('My rename'))
    expect(result.current).toBe('My rename')

    act(() => setTabTitle(null))
    expect(result.current).toBe('Original prompt')
  })
})
