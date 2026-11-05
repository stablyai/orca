import { vi } from 'vitest'
import type { AutomationRun } from '../../src/shared/automations-types'
import { getAutomationRunOperations } from '../../src/main/persistence/loading-store/automation-persistence'
import { RunTerminalRetentionIndex } from '../../src/main/automations/run-terminal-retention-index'
import type { fleet } from './terminal-retention-fleet.test-fixture'

export function observeFleet(h: Awaited<ReturnType<typeof fleet>>) {
  const state = getAutomationRunOperations(h.store).state
  const counts = {
    source: 0,
    derivation: 0,
    store: 0,
    watcher: 0,
    storeList: 0,
    storeTouch: 0,
    local: 0,
    ancestry: 0,
    reads: 0,
    replacements: 0,
    publications: 0,
    ordering: 0,
    orderingInputs: 0,
    diagnostic: 0,
    membership: 0,
    watcherEntry: 0,
    properties: 0,
    diagnosticProperties: 0,
    usageLookup: 0,
    storeProperties: 0,
    storeListProperties: 0,
    definitionReads: 0
  }
  let active = true
  let diagnosing = false
  let instrumenting = false
  let storeDepth = 0
  let listDepth = 0
  const changes: number[][] = []
  const instrumentRow = (run: AutomationRun) => {
    for (const key of [
      'createdAt',
      'startedAt',
      'dispatchedAt',
      'automationId',
      'workspaceId',
      'terminalPaneKey',
      'terminalPtyId',
      'status',
      'id'
    ] as const) {
      const value = run[key]
      Object.defineProperty(run, key, {
        configurable: true,
        enumerable: true,
        get: () => {
          if (active) {
            if (instrumenting) {
              counts.diagnosticProperties++
            } else {
              counts.properties++
              if (storeDepth) {
                counts.storeProperties++
                return value
              }
              if (listDepth) {
                counts.storeListProperties++
                return value
              }
              const stack = new Error('observed run access').stack ?? ''
              const position = (name: string) => {
                const n = stack.indexOf(name)
                return n === -1 ? Infinity : n
              }
              const baseline = Math.min(
                position('updateAutomationRun'),
                position('sortedAutomationRuns'),
                position('touchAutomation'),
                position('run-usage-collection')
              )
              if (baseline !== Infinity && position('run-usage-collection') === baseline) {
                counts.usageLookup++
              }
              const membership = Math.min(
                position('run-terminal-retention-index'),
                position('headless-run-terminal-retention')
              )
              const watcher = position('run-completion-watcher')
              const ordering = position('compareRetainedRuns')
              if (ordering < Math.min(baseline, membership, watcher)) {
                counts.ordering++
                if (key === 'dispatchedAt') {
                  counts.orderingInputs++
                }
              } else if (membership < Math.min(baseline, watcher)) {
                counts.membership++
              } else if (watcher < baseline) {
                counts.watcherEntry++
              }
            }
          }
          return value
        }
      })
    }
  }
  const observe = (rows: AutomationRun[]) => {
    instrumenting = true
    rows.forEach((row, n) => {
      instrumentRow(row)
      Object.defineProperty(rows, n, {
        configurable: true,
        enumerable: true,
        get: () => {
          if (!active) {
            return row
          }
          if (diagnosing || instrumenting) {
            counts.diagnostic++
            return row
          }
          counts.source++
          if (storeDepth) {
            counts.store++
            return row
          }
          if (listDepth) {
            counts.storeList++
            return row
          }
          const stack = new Error('observed run access').stack ?? ''
          if (stack.includes('run-terminal-retention-index')) {
            counts.derivation++
          } else if (stack.includes('updateAutomationRun')) {
            counts.store++
          } else if (stack.includes('retain')) {
            counts.watcher++
          } else if (stack.includes('sortedAutomationRuns')) {
            counts.storeList++
          }
          return row
        }
      })
    })
    instrumenting = false
    return rows
  }
  let current = observe(state.automationRuns!)
  Object.defineProperty(state, 'automationRuns', {
    configurable: true,
    get: () => {
      if (active) {
        counts.reads++
      }
      return current
    },
    set: (rows: AutomationRun[]) => {
      const changed: number[] = []
      diagnosing = true
      for (let n = 0; n < Math.max(current.length, rows.length); n++) {
        if (current[n] !== rows[n]) {
          changed.push(n)
        }
      }
      diagnosing = false
      changes.push(changed)
      counts.replacements++
      current = observe(rows)
    }
  })
  const observeDefinitions = (rows: typeof state.automations) => {
    rows.forEach((row, n) =>
      Object.defineProperty(rows, n, {
        configurable: true,
        enumerable: true,
        get: () => {
          if (active) {
            counts.definitionReads++
            if (storeDepth || new Error('observed run access').stack?.includes('touchAutomation')) {
              counts.storeTouch++
            }
          }
          return row
        }
      })
    )
    return rows
  }
  let definitions = observeDefinitions(state.automations)
  Object.defineProperty(state, 'automations', {
    configurable: true,
    get: () => definitions,
    set: (rows: typeof state.automations) => {
      definitions = observeDefinitions(rows)
    }
  })
  const update = h.store.updateAutomationRun.bind(h.store)
  const updateObservation = vi
    .spyOn(h.store, 'updateAutomationRun')
    .mockImplementation((...args) => {
      storeDepth++
      try {
        return update(...args)
      } finally {
        storeDepth--
      }
    })
  const list = h.store.listAutomationRuns.bind(h.store)
  const listObservation = vi.spyOn(h.store, 'listAutomationRuns').mockImplementation((...args) => {
    listDepth++
    try {
      return list(...args)
    } finally {
      listDepth--
    }
  })
  const apply = RunTerminalRetentionIndex.prototype.apply
  const local = vi.spyOn(RunTerminalRetentionIndex.prototype, 'apply').mockImplementation(function (
    this: RunTerminalRetentionIndex,
    mutation
  ) {
    if (active) {
      counts.local++
    }
    return apply.call(this, mutation)
  })
  const get = h.records.getOperationRow.bind(h.records)
  const provenance = vi.spyOn(h.records, 'getOperationRow').mockImplementation((...args) => {
    if (active) {
      counts.ancestry++
    }
    return get(...args)
  })
  const publish = vi.spyOn(h.runtime, 'notifyAutomationsChanged').mockImplementation(() => {
    counts.publications++
  })
  return {
    counts,
    pause: () => {
      active = false
    },
    changes,
    source: () => current,
    finish: () => {
      Object.defineProperty(state, 'automations', {
        configurable: true,
        writable: true,
        value: definitions
      })
      updateObservation.mockRestore()
      listObservation.mockRestore()
      local.mockRestore()
      provenance.mockRestore()
      publish.mockRestore()
      Object.defineProperty(state, 'automationRuns', {
        configurable: true,
        writable: true,
        value: current
      })
    }
  }
}
