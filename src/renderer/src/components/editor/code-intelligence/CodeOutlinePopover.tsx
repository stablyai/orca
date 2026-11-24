import { useEffect, useMemo, useRef, useState } from 'react'
import { ListTree, X } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import type { CodeDocumentSymbol } from '@/store/code-intelligence/code-intelligence-types'
import {
  useCodeIntelligenceStore,
  type CodeOutlineState
} from '@/store/code-intelligence/use-code-intelligence-store'

type FlatOutlineEntry = {
  symbol: CodeDocumentSymbol
  depth: number
}

function flattenOutline(symbols: readonly CodeDocumentSymbol[], depth = 0): FlatOutlineEntry[] {
  const out: FlatOutlineEntry[] = []
  for (const sym of symbols) {
    out.push({ symbol: sym, depth })
    if (sym.children.length > 0) {
      out.push(...flattenOutline(sym.children, depth + 1))
    }
  }
  return out
}

export function CodeOutlinePopover({
  outline,
  onClose
}: {
  outline: CodeOutlineState
  onClose: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const jumpToLocation = useCodeIntelligenceStore((s) => s.jumpToLocation)

  const entries = useMemo(() => {
    const flat = flattenOutline(outline.symbols)
    const needle = query.trim().toLowerCase()
    if (!needle) {
      return flat
    }
    return flat.filter((entry) => entry.symbol.name.toLowerCase().includes(needle))
  }, [outline.symbols, query])

  const activeIdx = Math.min(selectedIndex, Math.max(0, entries.length - 1))

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    const onPointerDown = (e: PointerEvent): void => {
      if (e.target instanceof Node && !panelRef.current?.contains(e.target)) {
        onClose()
      }
    }
    window.addEventListener('pointerdown', onPointerDown, true)
    return () => window.removeEventListener('pointerdown', onPointerDown, true)
  }, [onClose])

  const jumpEntry = (entry: FlatOutlineEntry): void => {
    jumpToLocation({
      filePath: outline.filePath,
      line: entry.symbol.selectionLine,
      column: entry.symbol.selectionColumn
    })
  }

  return (
    <div className="fixed inset-x-0 top-14 z-50 flex justify-center px-4">
      <div
        ref={panelRef}
        role="dialog"
        aria-label={t('auto.components.editor.codeIntelligence.goToSymbol', 'Go to Symbol')}
        data-code-outline-popover="true"
        className="flex w-[480px] max-w-full flex-col overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-xl"
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            onClose()
          } else if (e.key === 'ArrowDown') {
            e.preventDefault()
            setSelectedIndex((i) => Math.min(i + 1, Math.max(0, entries.length - 1)))
          } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            setSelectedIndex((i) => Math.max(0, i - 1))
          } else if (e.key === 'Enter' && entries[activeIdx]) {
            e.preventDefault()
            jumpEntry(entries[activeIdx])
          }
        }}
      >
        <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-1.5">
          <div className="flex items-center gap-1.5 text-xs font-semibold">
            <ListTree className="size-3.5 text-primary" />
            <span>
              {t('auto.components.editor.codeIntelligence.fileStructure', 'File Structure')}
            </span>
            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
              {outline.source === 'lsp'
                ? t('auto.components.editor.codeIntelligence.sourceLsp', 'LSP')
                : t('auto.components.editor.codeIntelligence.sourceSyntax', 'Syntax')}
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('auto.components.editor.codeIntelligence.close', 'Close')}
            className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <X className="size-3.5" />
          </button>
        </div>

        <div className="border-b border-border/60 px-3 py-2">
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setSelectedIndex(0)
            }}
            placeholder={t(
              'auto.components.editor.codeIntelligence.filterSymbolsPlaceholder',
              'Filter symbols in current file...'
            )}
            className="w-full bg-transparent text-xs text-foreground placeholder:text-muted-foreground focus:outline-none"
          />
        </div>

        <div className="max-h-72 overflow-y-auto py-1 scrollbar-sleek">
          {entries.length === 0 ? (
            <div className="px-3 py-4 text-center text-xs text-muted-foreground">
              {t(
                'auto.components.editor.codeIntelligence.noSymbolsFound',
                'No symbols found in this file'
              )}
            </div>
          ) : (
            entries.map((entry, idx) => {
              const selected = idx === activeIdx
              return (
                <button
                  key={`${entry.depth}:${entry.symbol.kind}:${entry.symbol.name}:${entry.symbol.line}:${entry.symbol.selectionColumn}`}
                  type="button"
                  onClick={() => jumpEntry(entry)}
                  onMouseEnter={() => setSelectedIndex(idx)}
                  style={{ paddingLeft: `${12 + entry.depth * 14}px` }}
                  className={cn(
                    'flex w-full items-center justify-between gap-2 pr-3 py-1.5 text-left text-xs transition-colors',
                    selected ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50'
                  )}
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="shrink-0 rounded bg-muted px-1 py-0 font-mono text-[10px] text-muted-foreground">
                      {entry.symbol.kind}
                    </span>
                    <span className="truncate font-mono font-medium text-foreground">
                      {entry.symbol.name}
                    </span>
                    {entry.symbol.detail ? (
                      <span className="truncate text-[11px] text-muted-foreground">
                        {entry.symbol.detail}
                      </span>
                    ) : null}
                  </div>
                  <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                    :{entry.symbol.line}
                  </span>
                </button>
              )
            })
          )}
        </div>
      </div>
    </div>
  )
}
