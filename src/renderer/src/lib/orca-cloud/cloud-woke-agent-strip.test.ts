import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status/contracts/agent-status-types'
import {
  AGENT_RELAUNCH_GRACE_MS,
  AGENT_RELAUNCH_WATCH_MS,
  agentEvidenceAt,
  wokeAgentStripState
} from './cloud-woke-agent-strip'

const asleepAt = 1_000_000
const atPrompt = (): boolean => true
const showingAgent = (): boolean => false

describe('the woke-up strip on an agent pane (RA-WAKE)', () => {
  it('no strip once the host relaunched the agent (it reported in after the sleep)', () => {
    for (const sinceLiveMs of [0, 7_000, AGENT_RELAUNCH_GRACE_MS + 1]) {
      expect(
        wokeAgentStripState({
          capturedAt: asleepAt,
          evidenceAt: asleepAt + 60_000,
          sinceLiveMs,
          paneAtShellPrompt: atPrompt
        })
      ).toBe('relaunched')
    }
  })

  it('shows nothing while the relaunch may still come', () => {
    expect(
      wokeAgentStripState({
        capturedAt: asleepAt,
        evidenceAt: asleepAt - 5_000,
        sinceLiveMs: AGENT_RELAUNCH_GRACE_MS - 1,
        paneAtShellPrompt: atPrompt
      })
    ).toBe('waiting')
  })

  it('not relaunched after the grace, back at a bare shell: Restart', () => {
    expect(
      wokeAgentStripState({
        capturedAt: asleepAt,
        evidenceAt: asleepAt - 5_000,
        sinceLiveMs: AGENT_RELAUNCH_GRACE_MS,
        paneAtShellPrompt: atPrompt
      })
    ).toBe('restart')
    expect(
      wokeAgentStripState({
        capturedAt: asleepAt,
        evidenceAt: null,
        sinceLiveMs: AGENT_RELAUNCH_GRACE_MS,
        paneAtShellPrompt: atPrompt
      })
    ).toBe('restart')
  })

  it('never offers Restart over a screen that may be the running agent; watches, then lets go', () => {
    const at = (sinceLiveMs: number) =>
      wokeAgentStripState({
        capturedAt: asleepAt,
        evidenceAt: null,
        sinceLiveMs,
        paneAtShellPrompt: showingAgent
      })
    expect(at(AGENT_RELAUNCH_GRACE_MS)).toBe('watching')
    expect(at(AGENT_RELAUNCH_WATCH_MS)).toBe('relaunched')
  })

  it("a reconnect's restamped delivery time is not evidence of a relaunch", () => {
    const replayed = {
      updatedAt: asleepAt + 60_000,
      evidenceObservedAt: asleepAt - 5_000
    } as AgentStatusEntry
    expect(agentEvidenceAt(replayed)).toBe(asleepAt - 5_000)
    expect(agentEvidenceAt({ updatedAt: asleepAt + 60_000 } as AgentStatusEntry)).toBeNull()
  })
})
