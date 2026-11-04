import { retentionNow } from './terminal-reuse-retention.test-fixture'
import { expect, it, vi } from 'vitest'
import { getAutomationRunOperations } from '../../src/main/persistence/loading-store/automation-persistence'
import {
  AUTOMATION_AGENT_CALLER,
  automationRunOperationId
} from '../../src/main/automations/automation-run-operation'
import { rpcCallerOperationKey } from '../../src/main/runtime/rpc/rpc-caller-identity'
import { RUN_TERMINAL_GRACE_MS } from '../../src/main/automations/headless-run-terminal-retention'
import { fleet } from './terminal-retention-fleet.test-fixture'
import { observeFleet } from './terminal-retention-observation.test-fixture'
it('bounds added derivation from real drain and timer triggers while preserving every Store publication', async () => {
  const results: { trigger: string; population: number; added: number; ordering: number }[] = []
  for (const trigger of ['drain', 'timer', 'sleep', 'dead'] as const) {
    for (const population of [10, 100]) {
      const h = await fleet(
        trigger === 'timer' ? (population / 10) * 13 : population,
        trigger === 'timer',
        trigger === 'sleep'
      )
      if (trigger === 'sleep') {
        for (const seed of h.seeds) {
          h.store.updateAutomationRun({ runId: seed.id, status: 'completed' })
        }
        h.runtime.sleepTerminalsForWorktree = vi.fn(async (_selector, options) => {
          options!.beforeAction!()
          const pty = options!.soleLivePtyId!
          return { livePtyIds: [pty], stoppedPtyIds: [pty], remainingLivePtyIds: [] }
        })
      }
      if (trigger === 'dead') {
        h.stopped.push(...h.seeds.map((seed) => h.paneHandle.get(seed.terminalPaneKey!)!))
      }
      const definitions = new Map(h.store.listAutomations().map((row) => [row.id, row]))
      const reservations = h.seeds.map((seed) => {
        const pending = h.store.createAutomationRun(
          definitions.get(seed.automationId)!,
          seed.scheduledFor + 1,
          'scheduled'
        )
        return h.service.reserveTerminalRun(pending)!
      })
      const o = observeFleet(h)
      let released = 0
      try {
        if (trigger === 'timer') {
          vi.useFakeTimers()
          h.service.start()
          await h.advance(RUN_TERMINAL_GRACE_MS + 120_000)
          released = h.stopped.length
        } else {
          released = await h.service.releaseFinishedRunTerminals!()
        }
        o.pause()
        expect(released).toBe(trigger === 'dead' ? 0 : population)
        expect(o.counts.publications).toBe(trigger === 'sleep' ? population * 2 : population)
        expect(o.changes.every((changed) => changed.length === 1)).toBe(true)
        expect(reservations.every((entry) => !entry.signal.aborted)).toBe(true)
        expect(h.store.listAutomationRuns().filter((run) => run.terminalPtyId)).toHaveLength(
          trigger === 'timer' ? (population / 10) * 3 : 0
        )
        const added =
          o.counts.derivation +
          o.counts.local +
          o.counts.ancestry +
          o.counts.watcher +
          o.counts.membership +
          o.counts.watcherEntry
        expect(o.counts.orderingInputs % 2).toBe(0)
        const ordering = o.counts.orderingInputs / 2
        results.push({ trigger, population, added, ordering })
        console.info('retention-mutation-counts', {
          trigger,
          population,
          released,
          counts: o.counts,
          added,
          orderingComparisons: ordering,
          disjointObserved:
            o.counts.source +
            o.counts.properties +
            o.counts.definitionReads +
            o.counts.local +
            o.counts.ancestry +
            o.counts.reads +
            o.counts.replacements +
            o.counts.publications,
          diagnosticObservationWork: o.counts.diagnostic + o.counts.diagnosticProperties,
          diagnosticIncludedInSource: false
        })
      } finally {
        h.service.stop()
        o.finish()
        vi.useRealTimers()
      }
    }
    const [n, tenN] = results.filter((row) => row.trigger === trigger)
    expect(n.added).toBeGreaterThan(0)
    expect(tenN.added).toBeLessThanOrEqual(n.added * 11)
    expect(tenN.ordering).toBeLessThanOrEqual(Math.max(1, n.ordering) * 25)
  }
}, 120_000)

it('groups dead negative ancestry only until the next await/source, with expired and actually pruned creation proof', async () => {
  const results: { population: number; expired: number; pruned: number }[] = []
  for (const population of [10, 100]) {
    const h = await fleet(1)
    const seed = h.seeds[0]!
    const automation = h.store.listAutomations().find((a) => a.id === seed.automationId)!
    for (let n = 1; n < population; n++) {
      const row = h.store.createAutomationRun(automation, seed.scheduledFor + n + 1, 'manual')
      h.store.updateAutomationRun({
        runId: row.id,
        status: 'dispatched',
        workspaceId: seed.workspaceId,
        terminalPaneKey: seed.terminalPaneKey,
        terminalPtyId: seed.terminalPtyId
      })
    }
    const future = Date.now() + 2 * 24 * 60 * 60_000
    vi.spyOn(Date, 'now').mockReturnValue(future)
    h.stopped.push(h.paneHandle.get(seed.terminalPaneKey!)!)
    const o = observeFleet(h)
    try {
      expect(await h.service.releaseFinishedRunTerminals!()).toBe(0)
      const expired = o.counts.ancestry
      await h.records.admitGlobalOperation({
        callerKey: rpcCallerOperationKey(AUTOMATION_AGENT_CALLER),
        operationId: `prune-${population}`,
        fingerprint: 'controlled-prune',
        now: future
      })
      expect(
        h.records.getOperationRow(
          rpcCallerOperationKey(AUTOMATION_AGENT_CALLER),
          automationRunOperationId(seed, 'fresh-launch')
        )
      ).toBeNull()
      const beforePruned = o.counts.ancestry
      expect(await h.service.releaseFinishedRunTerminals!()).toBe(0)
      const pruned = o.counts.ancestry - beforePruned
      expect(o.counts.publications).toBe(0)
      expect(o.counts.replacements).toBe(0)
      expect(
        h.store
          .listAutomationRuns(automation.id)
          .every((run) => run.terminalPtyId === seed.terminalPtyId)
      ).toBe(true)
      expect(expired).toBeGreaterThan(0)
      expect(pruned).toBeGreaterThan(0)
      results.push({ population, expired, pruned })
      console.info('retention-negative-counts', { population, expired, pruned, counts: o.counts })
    } finally {
      h.service.stop()
      o.finish()
    }
  }
  expect(results[1].expired).toBeLessThanOrEqual(results[0].expired * 11)
  expect(results[1].pruned).toBeLessThanOrEqual(results[0].pruned * 11)
}, 120_000)

it('invalidates canonical derivation for reentrant flush writes, eviction and throws, with fresh final authority', async () => {
  for (const scenario of [
    'pending-owner',
    'flush-unrelated',
    'creator-eviction',
    'sync-throw',
    'late-usage',
    'expiry',
    'store-loss'
  ] as const) {
    const h = await fleet(2)
    const seed = h.seeds[0]!,
      other = h.seeds[1]!
    const firstHandle = h.paneHandle.get(seed.terminalPaneKey!)!
    const source = getAutomationRunOperations(h.store).state
    const flush = h.store.flushPendingOrThrowAsync.bind(h.store)
    let injected = false
    if (scenario === 'late-usage') {
      h.store.updateAutomationRun({ runId: seed.id, status: 'completed' })
    }
    vi.spyOn(h.store, 'flushPendingOrThrowAsync').mockImplementation((options) => {
      if (!injected && scenario === 'late-usage') {
        injected = true
        return Promise.resolve().then(() => {
          h.store.updateAutomationRun({ runId: other.id, status: 'pending' })
          return flush(options)
        })
      }
      if (!injected && !['pending-owner', 'expiry', 'store-loss'].includes(scenario)) {
        injected = true
        if (scenario === 'flush-unrelated') {
          h.store.updateAutomationRun({ runId: other.id, status: 'pending' })
        }
        if (scenario === 'creator-eviction') {
          const automation = h.store.listAutomations().find((a) => a.id === other.automationId)!
          const evictionTime = Date.now() + 20_000
          for (let n = 0; n < 102; n++) {
            vi.spyOn(Date, 'now').mockReturnValue(evictionTime + n)
            const run = h.store.createAutomationRun(automation, Date.now() + n + 10_000, 'manual')
            h.store.updateAutomationRun({ runId: run.id, status: 'skipped_precheck' })
          }
          vi.spyOn(Date, 'now').mockImplementation(retentionNow)
        }
        if (scenario === 'sync-throw') {
          throw new Error('controlled sync flush failure')
        }
      }
      return flush(options)
    })
    if (scenario === 'pending-owner') {
      h.control.beforeClose = () => {
        if (injected) {
          return
        }
        injected = true
        const row = h.store.createAutomationRun(h.automation, Date.now() + 10_000, 'manual')
        h.store.updateAutomationRun({
          runId: row.id,
          status: 'pending',
          workspaceId: seed.workspaceId,
          terminalPaneKey: seed.terminalPaneKey,
          terminalPtyId: seed.terminalPtyId
        })
      }
    }
    if (scenario === 'expiry' || scenario === 'store-loss') {
      h.runtime.confirmTerminalShellAlone = vi.fn(async () => {
        if (!injected) {
          injected = true
          if (scenario === 'expiry') {
            vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 2 * 24 * 60 * 60_000)
          } else {
            h.opened.mockReturnValue(null)
          }
        }
        return true
      })
    }
    const o = observeFleet(h)
    try {
      await h.service.releaseFinishedRunTerminals!()
      if (scenario === 'pending-owner') {
        expect(h.stopped).not.toContain(firstHandle)
        expect(source.automationRuns!.find((run) => run.id === seed.id)?.terminalPtyId).toBe(
          seed.terminalPtyId
        )
      } else if (scenario === 'flush-unrelated') {
        expect(h.stopped).toEqual([firstHandle])
        expect(source.automationRuns!.find((run) => run.id === other.id)?.status).toBe('pending')
      } else if (scenario === 'late-usage') {
        expect(h.stopped).toEqual([firstHandle])
        expect(source.automationRuns!.find((run) => run.id === other.id)?.status).toBe('pending')
        expect(source.automationRuns!.find((run) => run.id === seed.id)?.usage).not.toBeNull()
        expect(o.counts.replacements).toBe(3)
        expect(o.counts.publications).toBe(2)
      } else if (scenario === 'creator-eviction') {
        expect(source.automationRuns!.some((run) => run.id === other.id)).toBe(false)
        expect(h.stopped).toEqual([firstHandle])
        expect(o.counts.replacements).toBe(205)
      } else if (scenario === 'sync-throw') {
        expect(o.counts.replacements).toBe(2)
        expect(o.counts.publications).toBe(1)
        expect(h.stopped).toHaveLength(2)
      } else {
        expect(h.stopped).toEqual([])
        expect(o.counts.publications).toBe(0)
      }
      console.info('retention-invalidation-counts', { scenario, counts: o.counts })
    } finally {
      h.service.stop()
      o.finish()
    }
  }
}, 120_000)
