import { beforeEach, describe, expect, it } from 'vitest'
import type { AppState } from '../store/types'
import { buildMobileSessionWorktreeInputs } from './sync-runtime-graph/mobile-session-inputs'
import { collectMobileSessionWorktreeSourceRefs } from './sync-runtime-graph/mobile-session-worktree-sources'
import type { MobileSessionPublicationInputs } from './sync-runtime-graph/types'
import {
  DIRTY_WT,
  gateSideOf,
  makeGateState,
  patchGateState,
  resetPublicationCaches,
  type GateSide
} from './sync-runtime-graph-worktree-source-gate.test-support'

/**
 * The fingerprint is a claim that `buildMobileSessionWorktreeInputs` reads no *store or publication*
 * value that `collectMobileSessionWorktreeSourceRefs` does not. Recording both sides' property reads
 * turns that claim into a test: a builder that starts reading a slice the collector does not is a
 * silently stale worktree, and the census names the slice instead of waiting for someone to write
 * the mutation that exposes it.
 *
 * What this census cannot see, and must not be read as covering: `captureMountedTerminalSurfaces`
 * reads the live terminal registry and PaneManager/DOM, which no proxy over `state` or `publication`
 * observes. That input is fenced at the call site by `registeredTabIdsByWorktree`, not by the
 * fingerprint — see `sync-runtime-graph-late-terminal-mount.test.ts`.
 *
 * The oracle is an absence assertion, so the read sets are pinned exactly rather than counted: a
 * builder that stops reading something has to be noticed too, because a field nothing reads is a
 * field the fingerprint can drop.
 */

type SliceReads = { top: Set<string>; keyed: Map<string, Set<string>> }

function isRecordSlice(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype
  )
}

/**
 * Records both the `AppState` keys a run touches and, for record-valued slices, which entries it
 * indexed. The entry level is what makes the census granularity-aware: a collector that fingerprints
 * some *other* worktree's row reads the slice but not the key the builder read.
 */
function recordStateReads(state: AppState, run: (observed: AppState) => void): SliceReads {
  const top = new Set<string>()
  const keyed = new Map<string, Set<string>>()
  const sliceProxies = new Map<string, unknown>()
  run(
    new Proxy(state, {
      get: (target, key) => {
        // oxlint-disable-next-line anti-slop/no-reflect-get -- Proxy `get` trap: the key is a raw string|symbol, not a typed property of the target.
        const value: unknown = Reflect.get(target, key)
        if (typeof key !== 'string') {
          return value
        }
        top.add(key)
        if (!isRecordSlice(value)) {
          return value
        }
        const existing = sliceProxies.get(key)
        if (existing) {
          return existing
        }
        const entryKeys = new Set<string>()
        keyed.set(key, entryKeys)
        const sliceProxy = new Proxy(value, {
          get: (entries, entryKey) => {
            if (typeof entryKey === 'string') {
              entryKeys.add(entryKey)
            }
            // oxlint-disable-next-line anti-slop/no-reflect-get -- Proxy `get` trap: the key is a raw string|symbol, not a typed property of the target.
            return Reflect.get(entries, entryKey)
          }
        })
        sliceProxies.set(key, sliceProxy)
        return sliceProxy
      }
    })
  )
  return { top, keyed }
}

function recordPublicationReads(
  publication: MobileSessionPublicationInputs,
  run: (observed: MobileSessionPublicationInputs) => void
): Set<string> {
  const reads = new Set<string>()
  run(
    new Proxy(publication, {
      get: (target, key) => {
        if (typeof key === 'string') {
          reads.add(key)
        }
        // oxlint-disable-next-line anti-slop/no-reflect-get -- Proxy `get` trap: the key is a raw string|symbol, not a typed property of the target.
        return Reflect.get(target, key)
      }
    })
  )
  return reads
}

/**
 * A slice the collector took whole is covered at every key: it compares the whole reference, which
 * is conservative. A slice it indexed is covered only at the keys it indexed.
 */
function uncoveredReads(builder: SliceReads, collector: SliceReads): string[] {
  const uncovered: string[] = []
  for (const slice of builder.top) {
    if (!collector.top.has(slice)) {
      uncovered.push(slice)
      continue
    }
    const collectorKeys = collector.keyed.get(slice)
    if (!collectorKeys || collectorKeys.size === 0) {
      continue
    }
    for (const entryKey of builder.keyed.get(slice) ?? []) {
      if (!collectorKeys.has(entryKey)) {
        uncovered.push(`${slice}.${entryKey}`)
      }
    }
  }
  return uncovered.sort()
}

function censusOf(side: GateSide): {
  builder: SliceReads
  collector: SliceReads
  builderPublication: Set<string>
  collectorPublication: Set<string>
} {
  return {
    builder: recordStateReads(side.state, (observed) => {
      buildMobileSessionWorktreeInputs(observed, DIRTY_WT, side.publication)
    }),
    collector: recordStateReads(side.state, (observed) => {
      collectMobileSessionWorktreeSourceRefs(observed, DIRTY_WT, side.publication)
    }),
    builderPublication: recordPublicationReads(side.publication, (observed) => {
      buildMobileSessionWorktreeInputs(side.state, DIRTY_WT, observed)
    }),
    collectorPublication: recordPublicationReads(side.publication, (observed) => {
      collectMobileSessionWorktreeSourceRefs(side.state, DIRTY_WT, observed)
    })
  }
}

/** Every `AppState` slice one worktree's inputs are built from; see the pinning rationale above. */
const BUILDER_STATE_SLICES = [
  'activeBrowserTabIdByWorktree',
  'activeFileId',
  'activeFileIdByWorktree',
  'activeGroupIdByWorktree',
  'activeTabId',
  'activeTabType',
  'activeTabTypeByWorktree',
  'browserCertificateFailuresByPageId',
  'browserPagesByWorkspace',
  'groupsByWorktree',
  'layoutByWorktree',
  'tabBarOrderByWorktree',
  'tabsByWorktree',
  'unifiedTabsByWorktree',
  'worktreesByRepo'
]

const BUILDER_PUBLICATION_FIELDS = [
  'agentStatusByWorktreeId',
  'ambiguousTabIds',
  'browserTabsByWorktree',
  'editorDraftVersionByFileId',
  'generatedTitlesEnabled',
  'launchDraftByWorktree',
  'openFileIndexes',
  'runtimePaneTitleByWorktree',
  'terminalLayoutByWorktree',
  'terminalTheme'
]

beforeEach(() => {
  resetPublicationCaches()
})

describe('the gate reads every store value the inputs builder reads', () => {
  it('records no AppState slice or worktree entry the source-ref collector misses', () => {
    const { state } = makeGateState(2)
    const census = censusOf(gateSideOf(state))

    expect([...census.builder.top].sort()).toEqual(BUILDER_STATE_SLICES)
    expect(uncoveredReads(census.builder, census.collector)).toEqual([])
  })

  it('records no publication input the source-ref collector misses', () => {
    const { state } = makeGateState(2)
    const census = censusOf(gateSideOf(state))

    expect([...census.builderPublication].sort()).toEqual(BUILDER_PUBLICATION_FIELDS)
    expect(
      [...census.builderPublication].filter((field) => !census.collectorPublication.has(field))
    ).toEqual([])
  })

  // The complement that keeps the census above honest: `activeEditorTabType` sits behind a ternary
  // on `activeEditorFileId`, so a fixture with nothing open never reaches the active-tab-type slices
  // and cannot census them. The main fixture holds an open file for exactly this reason.
  it('leaves the active-tab-type slices unread when the worktree has no open file', () => {
    const { state } = makeGateState(2)
    const withoutOpenFile = patchGateState(state, { openFiles: [], activeFileId: null })
    const census = censusOf(gateSideOf(withoutOpenFile))

    expect(census.builder.top.has('activeTabTypeByWorktree')).toBe(false)
    expect(uncoveredReads(census.builder, census.collector)).toEqual([])
  })

  it('names the worktree whose entry the collector fingerprinted instead', () => {
    const { state } = makeGateState(2)
    const side = gateSideOf(state)
    const builder = recordStateReads(side.state, (observed) => {
      buildMobileSessionWorktreeInputs(observed, DIRTY_WT, side.publication)
    })
    const wrongWorktree = recordStateReads(side.state, (observed) => {
      collectMobileSessionWorktreeSourceRefs(observed, 'repo::/gate-filler-0', side.publication)
    })

    expect(uncoveredReads(builder, wrongWorktree)).toContain(`tabsByWorktree.${DIRTY_WT}`)
  })
})
