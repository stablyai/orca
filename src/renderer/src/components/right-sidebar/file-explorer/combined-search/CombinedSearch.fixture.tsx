import React, { useCallback, useMemo, useRef, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { FileTypeIcon, FolderIcon } from '@/components/icons/FileTypeIcon'
import { defineFixture } from '../../../../component-fixtures/component-fixture'
import type {
  SearchFileResult,
  SearchResult
} from '../../../../../../shared/file-search/code-search-types'
import { buildSearchRows } from '../content-search/search-rows'
import type { TreeNode } from '../tree/file-explorer-types'
import { CombinedSearchResults } from './CombinedSearchResults'
import { CombinedSearchStrip } from './CombinedSearchStrip'
import {
  createCombinedSearchRows,
  getCombinedSearchOptionId,
  type CombinedSearchRow
} from './combined-search-rows'
import { findNameMatches, NAME_MATCH_PREVIEW_LIMIT, type NameMatch } from './name-match-results'
import { useCombinedSearchNavigation } from './use-combined-search-navigation'
import type { NameMatchRowActions } from './use-name-match-row-actions'

const ROOT = '/fixture/lumen-shop'
const CORPUS: [string, string[]][] = [
  ['src/cart/cartStore.ts', ['export const useCartStore = create((set) => ({', '  items: [],']],
  [
    'src/cart/CartDrawer.tsx',
    [
      'export function CartDrawer({ open }: Props) {',
      '  const items = useCartStore((s) => s.items)',
      '  return <Sheet title="Your cart">'
    ]
  ],
  ['src/cart/useCart.ts', ['export function useCart() {']],
  ['src/cart/cartTotals.ts', ['export function cartTotals(subtotal: number, tax: number) {']],
  ['src/cart/CartBadge.tsx', ['export const CartBadge = ({ count }) => <Badge>{count}</Badge>']],
  [
    'src/cart/cart.test.ts',
    ["describe('cart', () => {", "  it('adds an item to the cart', () => {"]
  ],
  ['public/icons/cart-icon.svg', ['<svg viewBox="0 0 24 24">']],
  ['public/favicon.ico', []],
  [
    'src/billing/reconciliation/monthly-ledger-reconciliation-report-generator.ts',
    ['export function generateReconciliationReport(ledger: Ledger) {']
  ],
  ['src/checkout/subtotal.ts', ['export const subtotal = (items: Item[]) => items.length']],
  ['package.json', ['  "name": "lumen-shop",']],
  ['README.md', ['# Lumen shop']]
]
for (let n = 1; n <= 300; n += 1) {
  const id = String(n).padStart(3, '0')
  CORPUS.push([
    `src/i18n/generated/strings-${id}.ts`,
    [0, 1, 2, 3].map((k) => `export const STRING_${id}_${k} = t('key.${id}.${k}')`)
  ])
}
const PATHS = CORPUS.map(([path]) => path)
const TREE: [string, boolean][] = [
  ['public', true],
  ['src', true],
  ['package.json', false],
  ['README.md', false],
  ['tsconfig.json', false]
]

function searchText(query: string, caseSensitive: boolean, wholeWord: boolean, regex: boolean) {
  if (query.trim().length < 2) {
    return null
  }
  let source = regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (wholeWord) {
    source = `\\b(?:${source})\\b`
  }
  let pattern: RegExp
  try {
    pattern = new RegExp(source, caseSensitive ? '' : 'i')
  } catch {
    return { files: [], totalMatches: 0, truncated: false } satisfies SearchResult
  }
  const files: SearchFileResult[] = []
  let totalMatches = 0
  for (const [path, lines] of CORPUS) {
    const matches = lines.flatMap((lineContent, index) => {
      const hit = pattern.exec(lineContent)
      return hit
        ? [{ line: index + 1, column: hit.index + 1, matchLength: hit[0].length, lineContent }]
        : []
    })
    if (matches.length > 0) {
      totalMatches += matches.length
      files.push({ filePath: `${ROOT}/${path}`, relativePath: path, matches })
    }
  }
  return { files, totalMatches, truncated: false } satisfies SearchResult
}

function FixtureTree(): React.JSX.Element {
  return (
    <div className="py-2">
      {TREE.map(([name, isDir]) => (
        <div key={name} className="flex items-center gap-1 px-2 py-1 text-xs">
          {isDir ? (
            <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
          ) : (
            <span className="size-3 shrink-0" />
          )}
          {isDir ? (
            <FolderIcon
              folderPath={name}
              open={false}
              className="size-3 shrink-0 text-muted-foreground"
            />
          ) : (
            <FileTypeIcon filePath={name} className="size-3 shrink-0 text-muted-foreground" />
          )}
          <span className="truncate">{name}</span>
        </div>
      ))}
    </div>
  )
}

const noop = (): void => {}
const ROW_ACTIONS: NameMatchRowActions = {
  open: noop,
  copyPaths: noop,
  startNew: noop,
  startRename: noop,
  duplicate: noop,
  requestDelete: noop,
  dragStart: noop,
  canOpenInOrcaBrowser: () => false,
  deleteShortcutLabel: '⌘⌫',
  connectionId: null,
  runtimeDownloadContext: null
}

/** Drives the real field, row model, keyboard model and list over an in-memory repo; no IPC. */
function CombinedSearchHarness({
  initialQuery,
  initialInclude = '',
  initialExclude = '',
  cappedNames = false,
  textUnavailable = false
}: {
  initialQuery: string
  initialInclude?: string
  initialExclude?: string
  /** Simulates a capped listing whose rows all fall outside the view. */
  cappedNames?: boolean
  /** Simulates a workspace whose text scan is skipped (two hosts publish it). */
  textUnavailable?: boolean
}): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState(initialQuery)
  const [showAllQuery, setShowAllQuery] = useState<string | null>(null)
  const [options, setOptions] = useState({ caseSensitive: false, wholeWord: false, regex: false })
  const [filters, setFilters] = useState({
    includePattern: initialInclude,
    excludePattern: initialExclude
  })
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const [opened, setOpened] = useState('')
  const hasQuery = query.trim().length > 0
  const names = useMemo(
    () =>
      hasQuery
        ? findNameMatches({
            relativePaths: PATHS,
            query,
            worktreePath: ROOT,
            displayRootPath: ROOT,
            showDotfiles: false,
            limit: showAllQuery === query ? null : NAME_MATCH_PREVIEW_LIMIT
          })
        : null,
    [hasQuery, query, showAllQuery]
  )
  const text = useMemo(
    () => searchText(query, options.caseSensitive, options.wholeWord, options.regex),
    [options, query]
  )
  const model = useMemo(
    () =>
      createCombinedSearchRows({
        names: cappedNames ? { total: 0, matches: [], truncated: true } : names,
        textResult: cappedNames || textUnavailable ? null : text,
        textRows: buildSearchRows(text, collapsed),
        textPending: false,
        textNotice: textUnavailable ? 'Not available here' : null
      }),
    [cappedNames, collapsed, names, text, textUnavailable]
  )
  const clearQuery = useCallback(() => setQuery(''), [])
  const openRow = useCallback(
    (row: CombinedSearchRow) => {
      if (row.type === 'name') {
        setOpened(row.match.relativePath)
      } else if (row.type === 'show-all') {
        setShowAllQuery(query)
      } else if (row.type === 'match') {
        setOpened(`${row.fileResult.relativePath}:${row.match.line}`)
      } else if (row.type === 'file') {
        const path = row.fileResult.filePath
        setCollapsed((current) => {
          const next = new Set(current)
          if (!next.delete(path)) {
            next.add(path)
          }
          return next
        })
      }
    },
    [query]
  )
  const { activeIndex, activateRow, handleKeyDown } = useCombinedSearchNavigation({
    query,
    model,
    inputRef,
    clearQuery,
    openRow
  })
  const toNode = useCallback(
    (match: NameMatch): TreeNode => ({
      name: match.name,
      path: `${ROOT}/${match.relativePath}`,
      relativePath: match.relativePath,
      isDirectory: false,
      depth: match.relativePath.split('/').length - 1
    }),
    []
  )

  return (
    <div className="flex h-[460px] flex-col bg-sidebar text-foreground" data-opened={opened}>
      <CombinedSearchStrip
        inputRef={inputRef}
        field={{
          query,
          loading: false,
          caseSensitive: options.caseSensitive,
          wholeWord: options.wholeWord,
          useRegex: options.regex,
          activeDescendantId:
            hasQuery && activeIndex !== -1 ? getCombinedSearchOptionId(activeIndex) : undefined,
          onQueryChange: setQuery,
          onKeyDown: handleKeyDown,
          onClear: clearQuery,
          onToggleCaseSensitive: () =>
            setOptions((current) => ({ ...current, caseSensitive: !current.caseSensitive })),
          onToggleWholeWord: () =>
            setOptions((current) => ({ ...current, wholeWord: !current.wholeWord })),
          onToggleRegex: () => setOptions((current) => ({ ...current, regex: !current.regex }))
        }}
        filters={{
          ...filters,
          onIncludeChange: (includePattern) =>
            setFilters((current) => ({ ...current, includePattern })),
          onExcludeChange: (excludePattern) =>
            setFilters((current) => ({ ...current, excludePattern }))
        }}
      />
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <FixtureTree />
        {hasQuery ? (
          <div className="absolute inset-0 flex min-h-0 flex-col bg-sidebar">
            <CombinedSearchResults
              model={model}
              activeIndex={activeIndex}
              listboxId="file-explorer-combined-search-results"
              onActivateRow={activateRow}
              rowActions={ROW_ACTIONS}
              toNode={toNode}
              workspaceId={null}
              onMenuClosed={() => inputRef.current?.focus()}
            />
          </div>
        ) : null}
      </div>
    </div>
  )
}

const focusField = (frame: HTMLElement): void => {
  frame.querySelector<HTMLInputElement>('input[role="combobox"]')?.focus()
}

export const empty = defineFixture({
  width: 300,
  render: () => <CombinedSearchHarness initialQuery="" />
})
export const emptyFocused = defineFixture({
  width: 300,
  render: () => <CombinedSearchHarness initialQuery="" />,
  interact: focusField
})
export const shortNarrow = defineFixture({
  width: 220,
  render: () => <CombinedSearchHarness initialQuery="cart" />
})
export const shortWide = defineFixture({
  width: 420,
  render: () => <CombinedSearchHarness initialQuery="cart" />
})
export const oneHit = defineFixture({
  width: 300,
  render: () => <CombinedSearchHarness initialQuery="favicon" />
})
export const manyTextHits = defineFixture({
  width: 300,
  render: () => <CombinedSearchHarness initialQuery="const" />
})
export const longNamesNarrow = defineFixture({
  width: 220,
  render: () => <CombinedSearchHarness initialQuery="reconciliation" />
})
export const noResults = defineFixture({
  width: 300,
  render: () => <CombinedSearchHarness initialQuery="zebra42" />
})
export const filterActive = defineFixture({
  width: 300,
  render: () => <CombinedSearchHarness initialQuery="" initialInclude="src/**" />
})
export const shortMedium = defineFixture({
  width: 300,
  render: () => <CombinedSearchHarness initialQuery="cart" />
})
export const refineNarrow = defineFixture({
  width: 220,
  render: () => <CombinedSearchHarness initialQuery="ts" cappedNames />
})
export const longFilterNarrow = defineFixture({
  width: 220,
  render: () => (
    <CombinedSearchHarness
      initialQuery=""
      initialInclude="src/**"
      initialExclude="dist/**, node_modules/**"
    />
  )
})
export const textUnavailable = defineFixture({
  width: 300,
  render: () => <CombinedSearchHarness initialQuery="cart" textUnavailable />
})
export const textUnavailableNarrow = defineFixture({
  width: 220,
  render: () => <CombinedSearchHarness initialQuery="cart" textUnavailable />
})
