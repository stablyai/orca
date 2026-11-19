// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import type { AiVaultSession } from '../../../../../../shared/ai-vault/contracts/ai-vault-types'
import {
  resetTerminalSessionNamesForTest,
  saveTerminalSessionName
} from '@/lib/agent-session/history/session-names/terminal-session-names'
import { useAiVaultSessionDisplayTitle } from './use-ai-vault-session-display-title'

const session: AiVaultSession = {
  id: 'row-1',
  executionHostId: 'local',
  agent: 'claude',
  sessionId: 's1',
  title: 'please look at the failing auth test',
  cwd: null,
  branch: null,
  model: null,
  filePath: '/sessions/s1.jsonl',
  codexHome: null,
  createdAt: null,
  updatedAt: null,
  modifiedAt: '2026-11-18T00:00:00.000Z',
  messageCount: 2,
  totalTokens: 0,
  previewMessages: [],
  queuedMessageCount: 0,
  subagentTranscriptCount: 0,
  resumeCommand: 'claude --resume s1',
  subagent: null
}

describe('useAiVaultSessionDisplayTitle for terminal rows', () => {
  beforeEach(() => {
    localStorage.clear()
    resetTerminalSessionNamesForTest()
  })

  it("shows the agent's own title when the tab was never named", () => {
    const { result } = renderHook(() => useAiVaultSessionDisplayTitle(session, null))
    expect(result.current.title).toBe('please look at the failing auth test')
  })

  it('keeps the tab name after the tab closed, and updates when it changes', () => {
    saveTerminalSessionName({
      executionHostId: 'local',
      sessionId: 's1',
      agent: 'claude',
      tabId: 'closed-tab',
      title: 'Fix auth bug'
    })
    const { result } = renderHook(() => useAiVaultSessionDisplayTitle(session, null))
    expect(result.current.title).toBe('Fix auth bug')
    act(() => {
      saveTerminalSessionName({
        executionHostId: 'local',
        sessionId: 's1',
        agent: 'claude',
        tabId: 'closed-tab',
        title: 'Auth fixed'
      })
    })
    expect(result.current.title).toBe('Auth fixed')
  })

  it("does not show another host's name for the same session id", () => {
    saveTerminalSessionName({
      executionHostId: 'runtime:other',
      sessionId: 's1',
      agent: 'claude',
      tabId: 't',
      title: 'Elsewhere'
    })
    const { result } = renderHook(() => useAiVaultSessionDisplayTitle(session, null))
    expect(result.current.title).toBe('please look at the failing auth test')
  })
})
