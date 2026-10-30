import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import {
  selectAutomationAgentStatusEntryChange,
  UNCHANGED_AUTOMATION_AGENT_STATUS_ENTRY
} from './automation-agent-status-entry-change'

function makeEntry(paneKey: string): AgentStatusEntry {
  return {
    paneKey,
    state: 'working',
    prompt: 'turn',
    updatedAt: 1,
    stateStartedAt: 1,
    stateHistory: []
  }
}

describe('selectAutomationAgentStatusEntryChange', () => {
  it('reads only the target and skips an unchanged entry', () => {
    const targetPaneKey = 'target-tab:leaf'
    const targetEntry = makeEntry(targetPaneKey)
    const entries = Object.fromEntries(
      Array.from({ length: 499 }, (_, index) => {
        const paneKey = `other-tab:${index}`
        return [paneKey, makeEntry(paneKey)]
      })
    )
    entries[targetPaneKey] = targetEntry
    let enumerations = 0
    const measuredEntries = new Proxy(entries, {
      ownKeys: (target) => {
        enumerations += 1
        return Reflect.ownKeys(target)
      }
    })

    expect(selectAutomationAgentStatusEntryChange(measuredEntries, targetPaneKey, undefined)).toBe(
      targetEntry
    )
    expect(
      selectAutomationAgentStatusEntryChange(measuredEntries, targetPaneKey, targetEntry)
    ).toBe(UNCHANGED_AUTOMATION_AGENT_STATUS_ENTRY)
    expect(enumerations).toBe(0)
  })

  it('reports removal and ignores inherited or non-enumerable entries', () => {
    const targetPaneKey = 'target-tab:leaf'
    const previousEntry = makeEntry(targetPaneKey)
    const inheritedEntries = Object.create({ [targetPaneKey]: previousEntry }) as Record<
      string,
      AgentStatusEntry
    >
    const nonEnumerableEntries = Object.defineProperty({}, targetPaneKey, {
      value: previousEntry
    }) as Record<string, AgentStatusEntry>

    expect(selectAutomationAgentStatusEntryChange({}, targetPaneKey, previousEntry)).toBeUndefined()
    expect(selectAutomationAgentStatusEntryChange(inheritedEntries, targetPaneKey, undefined)).toBe(
      UNCHANGED_AUTOMATION_AGENT_STATUS_ENTRY
    )
    expect(
      selectAutomationAgentStatusEntryChange(nonEnumerableEntries, targetPaneKey, undefined)
    ).toBe(UNCHANGED_AUTOMATION_AGENT_STATUS_ENTRY)
  })
})
