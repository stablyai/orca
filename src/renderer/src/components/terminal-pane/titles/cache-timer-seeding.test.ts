import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../../../shared/agent-status/contracts/agent-status-types'
import type { PaneForegroundAgentEntry } from '@/store/slices/agent-status/pane-foreground-agent'
import { foregroundIsLiveClaude } from '@/lib/agent-status/evidence/prompt-cache-request-evidence'
import { shouldSeedCacheTimerOnInitialTitle } from './cache-timer-seeding'

function restoredClaudeRow(overrides: Partial<AgentStatusEntry>): AgentStatusEntry {
  return {
    state: 'done',
    prompt: 'fix the bug',
    agentType: 'claude',
    paneKey: 'tab-1:leaf-1',
    updatedAt: 1_000,
    stateStartedAt: 1_000,
    stateHistory: [],
    turnEndedAt: 1_000,
    ...overrides
  }
}

function restore(args: {
  rawTitle?: string
  entry?: AgentStatusEntry
  promptCacheTimerEnabled?: boolean
  foreground?: PaneForegroundAgentEntry
}): ReturnType<typeof shouldSeedCacheTimerOnInitialTitle> {
  return shouldSeedCacheTimerOnInitialTitle({
    rawTitle: args.rawTitle ?? '✳ Claude Code',
    allowInitialIdleSeed: true,
    existing: undefined,
    promptCacheTimerEnabled: args.promptCacheTimerEnabled ?? true,
    agentStatusHooksEnabled: true,
    entry: args.entry,
    liveClaude: foregroundIsLiveClaude(args.foreground),
    now: 5_000
  })
}

describe('shouldSeedCacheTimerOnInitialTitle', () => {
  it('starts a restored Claude countdown at its turn end', () => {
    expect(restore({ entry: restoredClaudeRow({}) })).toBe(1_000)
  })

  it('starts a named Claude session at its turn end once a process read shows Claude', () => {
    const foreground: PaneForegroundAgentEntry = {
      agent: 'claude',
      agentEvidence: 'process-read',
      shellForeground: false
    }
    expect(restore({ rawTitle: 'Greeting reply', entry: restoredClaudeRow({}), foreground })).toBe(
      1_000
    )
  })

  it('starts a restored countdown at the lead turn end while background tasks keep the row working', () => {
    const entry = restoredClaudeRow({
      state: 'working',
      workingMode: 'monitoring',
      mainAgent: { state: 'done', stateStartedAt: 2_000 },
      turnEndedAt: undefined
    })
    expect(restore({ entry })).toBe(2_000)
  })

  it('does not seed a restored Claude session that never sent a request', () => {
    expect(restore({ entry: restoredClaudeRow({ prompt: '', sessionBoundary: true }) })).toBeNull()
  })

  it('keeps request evidence while the timer setting is off', () => {
    expect(restore({ entry: restoredClaudeRow({}), promptCacheTimerEnabled: false })).toBe(
      'requested'
    )
  })

  it('trusts a hookless working title when a live process read shows Claude', () => {
    const foreground: PaneForegroundAgentEntry = {
      agent: 'claude',
      agentEvidence: 'process-read',
      shellForeground: false
    }
    expect(restore({ rawTitle: '⠂ Claude Code', foreground })).toBe('requested')
  })
})
