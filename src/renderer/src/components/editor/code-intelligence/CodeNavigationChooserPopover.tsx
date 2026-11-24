import { useEffect, useMemo, useRef, useState } from 'react'
import { FileCode2, X } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import type { CodeChooserState } from '@/store/code-intelligence/use-code-intelligence-store'
import { useCodeIntelligenceStore } from '@/store/code-intelligence/use-code-intelligence-store'

function displayRelativeLocation(filePath: string, workspaceRoot: string | null): string {
  const normFile = filePath.replace(/\\/g, '/')
  if (workspaceRoot) {
    const normRoot = workspaceRoot.replace(/\\/g, '/').replace(/\/+$/, '')
    if (normFile.toLowerCase().startsWith(`${normRoot.toLowerCase()}/`)) {
      return normFile.slice(normRoot.length + 1)
    }
  }
  const parts = normFile.split('/')
  return parts.length > 3 ? `.../${parts.slice(-3).join('/')}` : normFile
}

export function CodeNavigationChooserPopover({
  chooser,
  workspaceRoot,
  onClose
}: {
  chooser: CodeChooserState
  workspaceRoot: string | null
  onClose: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const filterRef = useRef<HTMLInputElement | null>(null)
  const jumpToLocation = useCodeIntelligenceStore((s) => s.jumpToLocation)

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) {
      return chooser.items
    }
    return chooser.items.filter(
      (item) =>
        item.filePath.toLowerCase().includes(needle) ||
        (item.preview?.toLowerCase().includes(needle) ?? false)
    )
  }, [chooser.items, query])

  const activeIdx = Math.min(selectedIndex, Math.max(0, filtered.length - 1))

  useEffect(() => {
    filterRef.current?.focus()
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

  const left = Math.max(
    12,
    Math.min(chooser.anchor.x, (typeof window !== 'undefined' ? window.innerWidth : 1200) - 520)
  )
  const top = Math.max(
    12,
    Math.min(chooser.anchor.y, (typeof window !== 'undefined' ? window.innerHeight : 800) - 340)
  )

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-label={chooser.title}
      data-code-navigation-chooser="true"
      style={{ left, top }}
      className="fixed z-50 flex w-[500px] max-w-[calc(100vw-24px)] flex-col overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-xl"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          onClose()
        } else if (e.key === 'ArrowDown') {
          e.preventDefault()
          setSelectedIndex((i) => Math.min(i + 1, Math.max(0, filtered.length - 1)))
        } else if (e.key === 'ArrowUp') {
          e.preventDefault()
          setSelectedIndex((i) => Math.max(0, i - 1))
        } else if (e.key === 'Enter' && filtered[activeIdx]) {
          e.preventDefault()
          jumpToLocation(filtered[activeIdx])
        }
      }}
    >
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-1.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-xs font-semibold text-foreground">{chooser.title}</span>
          <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
            {chooser.source === 'lsp'
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

      <div className="border-b border-border/60 px-2.5 py-1.5">
        <input
          ref={filterRef}
          type="text"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setSelectedIndex(0)
          }}
          placeholder={t(
            'auto.components.editor.codeIntelligence.filterTargetsPlaceholder',
            'Filter targets by file or line content...'
          )}
          className="w-full bg-transparent text-xs text-foreground placeholder:text-muted-foreground focus:outline-none"
        />
      </div>

      <div className="max-h-64 overflow-y-auto py-1 scrollbar-sleek">
        {filtered.length === 0 ? (
          <div className="px-3 py-4 text-center text-xs text-muted-foreground">
            {t(
              'auto.components.editor.codeIntelligence.noMatchingLocations',
              'No matching locations'
            )}
          </div>
        ) : (
          filtered.map((item, idx) => {
            const rel = displayRelativeLocation(item.filePath, workspaceRoot)
            const selected = idx === activeIdx
            return (
              <button
                key={`${item.filePath}:${item.line}:${item.column}:${item.symbolName ?? ''}`}
                type="button"
                onClick={() => jumpToLocation(item)}
                onMouseEnter={() => setSelectedIndex(idx)}
                className={cn(
                  'flex w-full flex-col gap-0.5 px-3 py-1.5 text-left transition-colors',
                  selected ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50'
                )}
              >
                <div className="flex items-center justify-between gap-2 text-[11px]">
                  <span className="flex min-w-0 items-center gap-1.5 font-medium text-foreground">
                    <FileCode2 className="size-3.5 shrink-0 text-primary" />
                    <span className="truncate">{rel}</span>
                  </span>
                  <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                    :{item.line}:{item.column}
                  </span>
                </div>
                {item.preview ? (
                  <div className="truncate pl-5 font-mono text-[11px] text-muted-foreground">
                    {item.preview}
                  </div>
                ) : null}
              </button>
            )
          })
        )}
      </div>
    </div>
  )
}
