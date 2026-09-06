import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

// Guest retention is an OR over several independent signals, and every container from the app
// shell down to the guest has to agree on the list — Chromium stops painting inside a display:none
// subtree, so the *most* pinched ancestor wins. Adding a term (the remote-viewer signal, STA-4150)
// reached the panes while four hand-rolled copies still listed three: nothing typechecks a site
// that never names the new symbol. So the terms live behind one helper, and this census holds the
// sites to it — the classification is enforced here, not by review.

const RENDERER_SRC = join(__dirname, '..', '..', '..')

// The three term stores.
const RETENTION_TERM_STORES = [
  'components/browser-pane/host-guest/browser-automation-visibility.ts',
  'lib/pane-manager/browser-mobile-driver-state.ts',
  'lib/pane-manager/browser-remote-viewer-state.ts'
]

// ...plus the single module allowed to OR their terms together.
const RETENTION_TERM_OWNERS = [
  ...RETENTION_TERM_STORES,
  'components/browser-pane/host-guest/browser-guest-paint-retention.ts'
]

// Every way a term store lets a caller read one term. A site that hand-rolls the OR-list from
// readers missing here would pass the census, so the last check holds this list to the exports.
const RETENTION_TERM_SYMBOLS = [
  'isBrowserAutomationVisible',
  'useBrowserAutomationVisibilityForAny',
  'getBrowserAutomationVisiblePageIds',
  'onBrowserAutomationVisibilityChange',
  'isBrowserPageMobileDriven',
  'hasMobileDriverForAnyBrowserPage',
  'useBrowserMobileDriverForAny',
  'getBrowserMobileDrivenPageIds',
  'getDriverForBrowserPage',
  'useBrowserDriverForPage',
  'onBrowserDriverChange',
  'isBrowserPageRemotelyViewed',
  'hasRemoteViewerForAnyBrowserPage',
  'useBrowserRemoteViewerForAny',
  'getBrowserRemotelyViewedPageIds',
  'onBrowserRemoteViewerChange'
]

const RETENTION_HELPER_SYMBOLS = [
  'useAnyBrowserGuestNeedsPaint',
  'useBrowserGuestPaintRetention',
  'browserPageNeedsPaintRetention',
  'onBrowserGuestPaintRetentionChange',
  'browserTabsVetoGuestEviction'
]

// Every place that decides whether a browser guest keeps painting, and the helper it must use.
const RETENTION_SITES = new Map<string, readonly string[]>([
  ['components/TerminalWorkbenchContainer.tsx', ['useAnyBrowserGuestNeedsPaint']],
  // The two outermost workbench wrappers: strict ancestors of every guest, so the per-worktree
  // surface hatch below cannot rescue a guest either one parked with `hidden`.
  ['components/TerminalSurface.tsx', ['useAnyBrowserGuestNeedsPaint']],
  ['components/TerminalSplitWorkspaceSurfaces.tsx', ['useAnyBrowserGuestNeedsPaint']],
  ['components/TerminalWorktreeSplitSurface.tsx', ['useBrowserGuestPaintRetention']],
  [
    'components/browser-pane/assemble-chrome/BrowserPaneOverlayLayer.tsx',
    ['useBrowserGuestPaintRetention']
  ],
  [
    'components/browser-pane/host-guest/browser-guest-worktree-retention.ts',
    ['browserPageNeedsPaintRetention']
  ],
  [
    'components/use-terminal-browser-retention.ts',
    ['browserTabsVetoGuestEviction', 'onBrowserGuestPaintRetentionChange']
  ]
])

// The per-page threading hooks are the carve-out: they hand one boolean per page to
// browser-page-paintability's required fields, so a missing term IS a typecheck error there. They
// still travel as a set — a caller that reads two of the three is the same omission bug.
const PER_PAGE_RETENTION_HOOKS = [
  'useBrowserAutomationVisiblePageIds',
  'useBrowserMobileDrivenPageIds',
  'useBrowserRemotelyViewedPageIds'
]

// One production read of a term is not a retention decision: the pane reads *who* drives the active
// page to label the overlay and lock input. Naming the exception per file rather than dropping the
// symbol keeps every other file that reads it a census failure.
const NON_RETENTION_TERM_READERS = new Map<string, readonly string[]>([
  [
    'components/browser-pane/assemble-chrome/browser-workspace-pane.tsx',
    ['useBrowserDriverForPage']
  ]
])

// Writers, hydrators, the bridge installer and the idle sentinel: they set or seed a term rather
// than read it, so naming one is not a retention decision.
const NON_READER_TERM_EXPORTS = [
  'acquireBrowserAutomationVisibility',
  'releaseBrowserAutomationVisibility',
  'installBrowserAutomationVisibilityBridge',
  'setDriverForBrowserPage',
  'hydrateBrowserDrivers',
  'IDLE_BROWSER_DRIVER',
  'setRemoteViewersForBrowserPage',
  'hydrateBrowserRemoteViewerPages'
]

function productionSources(): Map<string, string> {
  const sources = new Map<string, string>()
  for (const entry of readdirSync(RENDERER_SRC, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !/\.tsx?$/.test(entry.name) || entry.name.endsWith('.d.ts')) {
      continue
    }
    if (/\.test\.tsx?$/.test(entry.name) || /test-(harness|rig|fixtures)/.test(entry.name)) {
      continue
    }
    const filePath = join(entry.parentPath, entry.name)
    sources.set(
      relative(RENDERER_SRC, filePath).split(sep).join('/'),
      readFileSync(filePath, 'utf8')
    )
  }
  return sources
}

function namedSymbols(source: string, symbols: readonly string[]): string[] {
  return symbols.filter((symbol) => new RegExp(`\\b${symbol}\\b`).test(source))
}

describe('browser guest retention site census', () => {
  const sources = productionSources()

  it('keeps every individual retention term behind the shared helper', () => {
    const offenders = [...sources]
      .filter(([file]) => !RETENTION_TERM_OWNERS.includes(file))
      .map(([file, source]) => ({
        file,
        terms: namedSymbols(source, RETENTION_TERM_SYMBOLS).filter(
          (term) => !(NON_RETENTION_TERM_READERS.get(file) ?? []).includes(term)
        )
      }))
      .filter(({ terms }) => terms.length > 0)
      .map(({ file, terms }) => `${file}: ${terms.join(', ')}`)
      .sort()

    expect(
      offenders,
      'A retention site that names terms one by one silently keeps its old list when a new signal ' +
        'is added. Call useBrowserGuestPaintRetention / browserPageNeedsPaintRetention instead, ' +
        'and register the site in RETENTION_SITES.'
    ).toEqual([])
  })

  it('registers every consumer of the shared retention helper', () => {
    const consumers = [...sources]
      .filter(
        ([file]) => file !== 'components/browser-pane/host-guest/browser-guest-paint-retention.ts'
      )
      .filter(([, source]) => namedSymbols(source, RETENTION_HELPER_SYMBOLS).length > 0)
      .map(([file]) => file)
      .sort()

    expect(consumers, 'New retention sites must be listed in RETENTION_SITES.').toEqual(
      [...RETENTION_SITES.keys()].sort()
    )
  })

  it('keeps each registered site consulting retention through its helper', () => {
    const missing: string[] = []
    for (const [file, requiredSymbols] of RETENTION_SITES) {
      const source = sources.get(file)
      expect(source, `${file} is registered as a retention site but no longer exists`).toBeDefined()
      for (const symbol of requiredSymbols) {
        if (!new RegExp(`\\b${symbol}\\b`).test(source ?? '')) {
          missing.push(`${file}: ${symbol}`)
        }
      }
    }
    expect(missing, 'A registered retention site stopped consulting retention.').toEqual([])
  })

  it('keeps the per-page threading hooks travelling as a full set', () => {
    const partial = [...sources]
      .filter(([file]) => !RETENTION_TERM_OWNERS.includes(file))
      .map(([file, source]) => ({ file, hooks: namedSymbols(source, PER_PAGE_RETENTION_HOOKS) }))
      .filter(({ hooks }) => hooks.length > 0 && hooks.length < PER_PAGE_RETENTION_HOOKS.length)
      .map(({ file, hooks }) => `${file}: only ${hooks.join(', ')}`)
      .sort()

    expect(
      partial,
      'A pane that threads some retention terms per page must thread all of them.'
    ).toEqual([])
  })

  // Keeps the symbol lists above from going stale: a term store that grows a new reader nobody
  // classified would otherwise be a free way to hand-roll the OR-list.
  it('classifies every value a term store exports', () => {
    const classified = new Set([
      ...RETENTION_TERM_SYMBOLS,
      ...PER_PAGE_RETENTION_HOOKS,
      ...NON_READER_TERM_EXPORTS
    ])
    const unclassified: string[] = []
    for (const file of RETENTION_TERM_STORES) {
      const source = sources.get(file)
      expect(source, `${file} is registered as a term store but no longer exists`).toBeDefined()
      for (const [, name] of (source ?? '').matchAll(/^export (?:function|const|let) (\w+)/gm)) {
        if (!classified.has(name)) {
          unclassified.push(`${file}: ${name}`)
        }
      }
    }

    expect(
      unclassified,
      'A term store exports something this census does not classify. Add a reader to ' +
        'RETENTION_TERM_SYMBOLS (or PER_PAGE_RETENTION_HOOKS, for the per-page hooks typecheck ' +
        'already covers) so hand-rolled sites keep failing, and a writer to NON_READER_TERM_EXPORTS.'
    ).toEqual([])
  })
})
