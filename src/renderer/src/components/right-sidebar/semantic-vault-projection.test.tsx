// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import { normalizeAgentStatusPayload } from '../../../../shared/agent-status-types'
import { semanticProjectionEntry } from '../dashboard/semantic-projection-fixture'
import {
  buildAiVaultOriginalPaneIndex,
  findAiVaultSessionLiveStateInIndex
} from './ai-vault-original-pane-index'
import { findAiVaultSessionLiveState, type OriginalPaneState } from './ai-vault-original-pane'
import { SessionMetadata } from './ai-vault-session-row-display'

afterEach(cleanup)

const session: AiVaultSession = {
  id: 'synthetic-session',
  executionHostId: 'local',
  agent: 'codex',
  sessionId: 'synthetic-session',
  title: 'Synthetic semantic projection task',
  cwd: '/synthetic/folder',
  branch: null,
  model: null,
  filePath: '/synthetic/session.jsonl',
  codexHome: null,
  createdAt: null,
  updatedAt: null,
  modifiedAt: '2026-09-08T00:00:00Z',
  messageCount: 1,
  totalTokens: 0,
  previewMessages: [],
  queuedMessageCount: 0,
  subagentTranscriptCount: 0,
  resumeCommand: '',
  subagent: null
}

function lookup(
  workingMode: 'monitoring' | undefined,
  direct: boolean,
  ambiguous = false,
  agent = session.agent
) {
  const normalized = normalizeAgentStatusPayload({
    state: 'working',
    workingMode,
    prompt: session.title
  })
  const entry = semanticProjectionEntry({
    ...normalized,
    state: 'working',
    interrupted: undefined,
    agentType: agent,
    providerSession: direct ? { key: 'session_id', id: session.sessionId } : undefined
  })
  const state: OriginalPaneState = {
    agentStatusByPaneKey: {
      one: entry,
      ...(ambiguous ? { two: { ...entry, paneKey: 'other-pane' } } : {})
    },
    retainedAgentsByPaneKey: {},
    sleepingAgentSessionsByPaneKey: {},
    tabsByWorktree: {},
    terminalLayoutsByTabId: {}
  }
  const target = { ...session, agent }
  const indexed = findAiVaultSessionLiveStateInIndex(buildAiVaultOriginalPaneIndex(state), target)
  expect(indexed).toBe(findAiVaultSessionLiveState(state, target))
  return indexed
}

describe('semantic Vault lookup to renderer', () => {
  it.each(['claude', 'codex', 'gemini'] as const)(
    'preserves monitoring and ordinary work for provider %s in both lookup modes',
    (agent) => {
      for (const direct of [true, false]) {
        for (const workingMode of ['monitoring', undefined] as const) {
          const liveState = lookup(workingMode, direct, false, agent)
          expect(liveState).toBe(workingMode ?? 'working')
          const { container } = render(
            <TooltipProvider>
              <SessionMetadata
                session={{ ...session, agent }}
                liveState={liveState}
                updatedAt="2026-09-08T00:00:00Z"
                worktreeInfo={null}
                vaultScope="all"
              />
            </TooltipProvider>
          )
          expect(
            screen.getByLabelText(workingMode ? 'Monitoring background tasks' : 'Working')
          ).toBeInTheDocument()
          expect(container.querySelector('.agent-working-spinner') !== null).toBe(!workingMode)
          cleanup()
        }
      }
    }
  )

  it('does not attribute an ambiguous prompt to any live pane', () => {
    expect(lookup('monitoring', false, true)).toBeNull()
  })

  it('does not let another provider or different provider session claim a prompt', () => {
    const entry = semanticProjectionEntry({
      state: 'working',
      workingMode: 'monitoring',
      providerSession: { key: 'session_id', id: 'different-session' }
    })
    const state: OriginalPaneState = {
      agentStatusByPaneKey: { one: entry },
      retainedAgentsByPaneKey: {},
      sleepingAgentSessionsByPaneKey: {},
      tabsByWorktree: {},
      terminalLayoutsByTabId: {}
    }
    expect(
      findAiVaultSessionLiveStateInIndex(buildAiVaultOriginalPaneIndex(state), session)
    ).toBeNull()
    state.agentStatusByPaneKey.one = {
      ...entry,
      agentType: 'claude',
      providerSession: { key: 'session_id', id: session.sessionId }
    }
    expect(
      findAiVaultSessionLiveStateInIndex(buildAiVaultOriginalPaneIndex(state), session)
    ).toBeNull()
  })
})
