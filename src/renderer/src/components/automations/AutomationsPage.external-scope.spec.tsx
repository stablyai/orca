// @vitest-environment happy-dom

/** Drive the page’s scope producer and inspect IPC; client tests with pre-narrowed scopes cannot verify which hosts the page asks. */

import { describe, expect, it } from 'vitest'

import {
  api,
  installAutomationsPageHarness,
  mocks,
  renderPage,
  settleHostQueries
} from './automations-page-test-harness'
import { listedExternalEntries } from './automations-page-listed-items'
import { makeExternalManager } from './automations-page-fixtures'

const DESKTOP_SELF_FILTER = {
  kind: 'host' as const,
  host: { authority: { kind: 'desktop' as const }, selector: { kind: 'self' as const } }
}

function sshFilter(targetId: string): unknown {
  return {
    kind: 'host',
    host: { authority: { kind: 'desktop' }, selector: { kind: 'ssh', targetId } }
  }
}

/** Registered SSH targets, each with the generation that makes it fenceable. */
function withSshHosts(...targetIds: string[]): void {
  mocks.state.sshTargetLabels = new Map(targetIds.map((targetId) => [targetId, targetId]))
  mocks.state.sshTargetGenerations = new Map(targetIds.map((targetId) => [targetId, 1]))
  mocks.state.sshConnectionStates = new Map(
    targetIds.map((targetId) => [targetId, { status: 'connected' }])
  )
}

function openclawOnly(): void {
  api.automations.listExternalManagerForOwner.mockImplementation(
    async ({ provider }: { provider: string }) =>
      provider === 'openclaw'
        ? { manager: makeExternalManager(), error: null, updatedAt: 1 }
        : { manager: null, error: null, updatedAt: 1 }
  )
}

describe('AutomationsPage external manager probes', () => {
  installAutomationsPageHarness()

  it('drops the previous host rows when the selection moves, not when the new probe lands', async () => {
    withSshHosts('staging')
    mocks.state.automationHostFilter = DESKTOP_SELF_FILTER
    openclawOnly()

    const { rerender } = await renderPage()
    await settleHostQueries()
    expect(listedExternalEntries().length).toBeGreaterThan(0)

    // The new host never answers, so anything still listed belongs to the old one.
    api.automations.listExternalManagerForOwner.mockImplementation(
      async () => await new Promise(() => undefined)
    )
    mocks.state.automationHostFilter = sshFilter('staging')
    await rerender()
    await settleHostQueries()

    expect(listedExternalEntries()).toEqual([])
  })
})
