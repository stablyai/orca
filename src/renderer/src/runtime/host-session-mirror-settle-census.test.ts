/**
 * Registry test for the host-session-mirror settle seam. Four review rounds
 * each found a NEW call site settling the latch out of order with its store
 * patch, so the seam is enforced structurally: a settle exists only as the
 * receipt of a landed patch (or as the audited stale-frame exception), and a
 * new patch or settle site fails this census until it adopts that contract.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

const RENDERER_SRC = join(import.meta.dirname, '..')

const SETTLE_RULE = [
  'The mirror latch settles EXACTLY when evidence reached the store.',
  'applyWebSessionTabsStorePatch returns the settle receipt for its own patch:',
  'capture it and invoke it after the frame finishes recovery. A frame whose',
  'patch wrote nothing settles through hostSessionMirrorSettleForPatchlessFrame,',
  'and ONLY on a decision carrying settlesHostMirror — a rejection backed by the',
  'equal/newer view already accepted into the store. Never derive that from a',
  'bare boolean: "the mirror never writes this workspace" is also a rejection,',
  'and settling on it drains parked resume work against state nobody wrote.',
  'A captured receipt that is never invoked wedges its pane instead, so every',
  'receipt has to reach a call. Never call markHostSessionMirror*Hydrated from',
  'feature code, and never add a boolean that remembers "the patch landed" —',
  'that ordering bug shipped four times. If you added a legitimate new site,',
  'update this census deliberately.'
].join(' ')

/** Receipt-minting calls. Every one owes its caller an invocation. */
const RECEIPT_CALLS = [
  'applyWebSessionTabsStorePatch(',
  'hostSessionMirrorSettleForPatchlessFrame('
] as const

/**
 * The binding a receipt was captured into, read backwards from the call.
 * TypeScript cannot express a must-call obligation and the invocation is
 * deliberately deferred to after `finishRecovery`, so this stays textual:
 * an unrecognised capture shape fails rather than passing unaudited.
 */
function receiptBindingName(before: string): string | null {
  const lines = before.split('\n')
  for (let line = lines.length - 1; line >= 0 && line > lines.length - 8; line -= 1) {
    const match = /\b(?:const|let|var)?\s*([A-Za-z_$][\w$]*)\s*(?::[^=]*?)?=(?![=>])/.exec(
      lines[line]!
    )
    if (match) {
      return match[1]!
    }
  }
  return null
}

function productionSources(): { path: string; source: string }[] {
  const sources: { path: string; source: string }[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry)
      if (statSync(path).isDirectory()) {
        walk(path)
        continue
      }
      if (!/\.(ts|tsx)$/.test(entry) || /\.test\.|\.d\.ts$/.test(entry)) {
        continue
      }
      sources.push({
        path: relative(RENDERER_SRC, path).split(sep).join('/'),
        source: readFileSync(path, 'utf8')
      })
    }
  }
  walk(RENDERER_SRC)
  return sources
}

function countOccurrences(source: string, needle: string): number {
  let count = 0
  for (
    let index = source.indexOf(needle);
    index !== -1;
    index = source.indexOf(needle, index + 1)
  ) {
    count += 1
  }
  return count
}

describe('host-session-mirror settle census', () => {
  const sources = productionSources()

  it('mirror marks are reachable only through the settle receipts', () => {
    const markCounts: Record<string, { hydrated: number; worktreeHydrated: number }> = {}
    for (const { path, source } of sources) {
      const hydrated = countOccurrences(source, 'markHostSessionMirrorHydrated(')
      const worktreeHydrated = countOccurrences(source, 'markHostSessionMirrorWorktreeHydrated(')
      if (hydrated + worktreeHydrated > 0) {
        markCounts[path] = { hydrated, worktreeHydrated }
      }
    }
    expect(markCounts, SETTLE_RULE).toEqual({
      // The definitions themselves.
      'runtime/host-session-mirror-hydration.ts': { hydrated: 1, worktreeHydrated: 1 },
      // Exactly the receipt constructors: the patch receipt (environment-wide
      // and per-worktree) and the stale-frame receipt.
      'runtime/web-session-tabs-sync.ts': { hydrated: 1, worktreeHydrated: 2 }
    })
  })

  it('every store patch call site captures its settle receipt', () => {
    const needle = 'applyWebSessionTabsStorePatch('
    const callSites: Record<string, number> = {}
    for (const { path, source } of sources) {
      let calls = 0
      for (
        let index = source.indexOf(needle);
        index !== -1;
        index = source.indexOf(needle, index + 1)
      ) {
        const before = source.slice(0, index).trimEnd()
        if (before.endsWith('function')) {
          continue // The definition.
        }
        calls += 1
        // A receipt is captured when the call is an expression consumed by an
        // assignment, return, ternary, or argument — never a bare statement.
        const capturedBy = before.slice(-1)
        expect(
          ['=', '(', ',', '?', ':', '{'].includes(capturedBy) || before.endsWith('return'),
          `${path} discards the settle receipt of applyWebSessionTabsStorePatch. ${SETTLE_RULE}`
        ).toBe(true)
      }
      if (calls > 0) {
        callSites[path] = calls
      }
    }
    expect(callSites, SETTLE_RULE).toEqual({
      // initial listAll, visibility-resume repair, full inventory, global
      // singular frame, scoped active frame.
      'runtime/web-session-tabs-sync.ts': 5,
      // The eager post-create session.tabs.list refresh.
      'runtime/web-runtime-session.ts': 1
    })
  })

  it('every captured settle receipt reaches an invocation', () => {
    const receiptBindings: Record<string, Record<string, number>> = {}
    for (const { path, source } of sources) {
      for (const needle of RECEIPT_CALLS) {
        for (
          let index = source.indexOf(needle);
          index !== -1;
          index = source.indexOf(needle, index + 1)
        ) {
          const before = source.slice(0, index).trimEnd()
          if (before.endsWith('function')) {
            continue // The definition.
          }
          const name = receiptBindingName(before)
          expect(
            name,
            `${path} captures a settle receipt in a shape this census cannot follow. ${SETTLE_RULE}`
          ).not.toBeNull()
          // The obligation is discharged by the next call of the same binding —
          // a fresh declaration of that name in between means the call belongs
          // to another receipt, so this one was dropped.
          const rest = source.slice(index + needle.length)
          const invocation = new RegExp(`\\b${name}\\s*(?:\\?\\.)?\\(`).exec(rest)
          const redeclared =
            invocation !== null &&
            new RegExp(`\\b(?:let|const|var)\\s+${name}\\b`).test(rest.slice(0, invocation.index))
          expect(
            invocation !== null && !redeclared,
            `${path} never invokes the settle receipt it captured into \`${name}\`. ${SETTLE_RULE}`
          ).toBe(true)
          const bindings = (receiptBindings[path] ??= {})
          bindings[name!] = (bindings[name!] ?? 0) + 1
        }
      }
    }
    // Pinning the resolved names keeps the rule from going vacuous: a binding
    // this census misreads settles on some other identifier's invocation.
    expect(receiptBindings, SETTLE_RULE).toEqual({
      // Four hydration receipts (initial listAll, full inventory, scoped active
      // frame patch, and its patchless twin) and three mirror ones
      // (visibility-resume repair, global singular frame patch and patchless).
      'runtime/web-session-tabs-sync.ts': { settleHydration: 4, settleMirror: 3 },
      'runtime/web-runtime-session.ts': { settleMirror: 1 }
    })
  })

  it('the patchless settle appears only at its audited sites', () => {
    const patchlessCounts: Record<string, number> = {}
    for (const { path, source } of sources) {
      const count = countOccurrences(source, 'hostSessionMirrorSettleForPatchlessFrame(')
      if (count > 0) {
        patchlessCounts[path] = count
      }
    }
    expect(patchlessCounts, SETTLE_RULE).toEqual({
      // The definition, the global singular frame, and the scoped active frame.
      'runtime/web-session-tabs-sync.ts': 3
    })
  })

  it('only the audited decisions grant a rejected frame a settle', () => {
    const settlingCounts: Record<string, number> = {}
    const silentCounts: Record<string, number> = {}
    for (const { path, source } of sources) {
      const settling = countOccurrences(source, 'settlesHostMirror: true')
      const silent = countOccurrences(source, 'settlesHostMirror: false')
      if (settling > 0) {
        settlingCounts[path] = settling
      }
      if (silent > 0) {
        silentCounts[path] = silent
      }
    }
    // A new decision has to be minted here, and minting one forces its author
    // to say whether the frame is host evidence — the whole point of the pair.
    expect(settlingCounts, SETTLE_RULE).toEqual({
      // The applied frame (its own patch) and the outranked one (the accepted view).
      'runtime/web-session-tabs-sync.ts': 2
    })
    expect(silentCounts, SETTLE_RULE).toEqual({
      // The unmirrored frame: no accepted view of it ever reached the store.
      'runtime/web-session-tabs-sync.ts': 1
    })
  })
})
