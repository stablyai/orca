// @vitest-environment happy-dom

/**
 * What the page actually asks the main process about external managers.
 *
 * The engine-level tests hand a pre-narrowed scope list to the client, so they
 * prove the plumbing and nothing about the producer. These drive the page: the
 * selection is the input and the IPC calls it issues are the observation.
 */

import { describe, expect, it } from 'vitest'
import type { AutomationOwnerRef } from '../../../../shared/automation-owner-ref'
import {
  api,
  DESKTOP_SELF_OWNER,
  installAutomationsPageHarness,
  mocks,
  renderPage,
  runtimeHost,
  RUNTIME_SELF_FILTER,
  settleHostQueries
} from './automations-page-test-harness'
import { makeExternalManager } from './automations-page-fixtures'

installAutomationsPageHarness()

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

function probedOwners(): AutomationOwnerRef[] {
  return api.automations.listExternalManagerForOwner.mock.calls.map(
    (call) => (call[0] as { owner: AutomationOwnerRef }).owner
  )
}

function lastRetainedOwners(): readonly AutomationOwnerRef[] {
  const calls = api.automations.retainExternalScopes.mock.calls
  return (calls.at(-1)?.[0] as { owners: readonly AutomationOwnerRef[] } | undefined)?.owners ?? []
}

function hermesOnly(): void {
  api.automations.listExternalManagerForOwner.mockImplementation(
    async ({ provider }: { provider: string }) =>
      provider === 'hermes'
        ? { manager: makeExternalManager(), error: null, updatedAt: 1 }
        : { manager: null, error: null, updatedAt: 1 }
  )
}

describe('AutomationsPage external manager probes', () => {
  it('probes no SSH host when the selection is the local desktop', async () => {
    withSshHosts('staging', 'web-01', 'web-02')
    mocks.state.automationHostFilter = DESKTOP_SELF_FILTER
    hermesOnly()

    await renderPage()
    await settleHostQueries()

    const sshProbes = probedOwners().filter((owner) => owner.selector.kind === 'ssh')
    expect(sshProbes).toEqual([])
    expect(probedOwners()).toEqual([DESKTOP_SELF_OWNER, DESKTOP_SELF_OWNER])
  })

  it('retains only the selected host, so probes elsewhere are cancelled', async () => {
    withSshHosts('staging', 'web-01', 'web-02')
    mocks.state.automationHostFilter = DESKTOP_SELF_FILTER
    hermesOnly()

    await renderPage()
    await settleHostQueries()

    expect(lastRetainedOwners()).toEqual([DESKTOP_SELF_OWNER])
  })

  it('cancels the previous host as soon as the filter moves off it', async () => {
    withSshHosts('staging')
    mocks.state.automationHostFilter = DESKTOP_SELF_FILTER
    hermesOnly()

    const { rerender } = await renderPage()
    await settleHostQueries()
    mocks.state.automationHostFilter = sshFilter('staging')
    await rerender()
    await settleHostQueries()

    expect(lastRetainedOwners()).toEqual([
      {
        authority: { kind: 'desktop' },
        selector: { kind: 'ssh', targetId: 'staging', targetGeneration: 1 }
      }
    ])
  })

  it('lists no external rows for a host whose managers it says are not listed', async () => {
    runtimeHost([], [])
    mocks.state.automationHostFilter = RUNTIME_SELF_FILTER
    hermesOnly()

    await renderPage()
    await settleHostQueries()

    expect(mocks.listPanel?.filteredExternalAutomationEntries).toEqual([])
  })

  it('drops the previous host rows when the selection moves, not when the new probe lands', async () => {
    withSshHosts('staging')
    mocks.state.automationHostFilter = DESKTOP_SELF_FILTER
    hermesOnly()

    const { rerender } = await renderPage()
    await settleHostQueries()
    expect(mocks.listPanel?.filteredExternalAutomationEntries.length).toBeGreaterThan(0)

    // The new host never answers, so anything still listed belongs to the old one.
    api.automations.listExternalManagerForOwner.mockImplementation(
      async () => await new Promise(() => undefined)
    )
    mocks.state.automationHostFilter = sshFilter('staging')
    await rerender()
    await settleHostQueries()

    expect(mocks.listPanel?.filteredExternalAutomationEntries).toEqual([])
  })

  it('reports a host it could not check rather than showing it as clean', async () => {
    mocks.state.automationHostFilter = DESKTOP_SELF_FILTER
    api.automations.listExternalManagerForOwner.mockImplementation(
      async ({ provider }: { provider: string }) =>
        provider === 'hermes'
          ? { manager: null, error: 'hermes probe failed: channel closed', updatedAt: 0 }
          : { manager: null, error: null, updatedAt: 0 }
    )

    await renderPage()
    await settleHostQueries()

    const desktopLabel = mocks.listPanel?.hostCatalog.entries[0]?.label
    expect(mocks.listPanel?.externalManagersUncheckedNotice).toBe(
      `External automation managers on ${desktopLabel} could not be checked.`
    )
  })

  it('says nothing about unchecked hosts when every probe answered', async () => {
    mocks.state.automationHostFilter = DESKTOP_SELF_FILTER
    hermesOnly()

    await renderPage()
    await settleHostQueries()

    expect(mocks.listPanel?.externalManagersUncheckedNotice).toBeNull()
  })
})
