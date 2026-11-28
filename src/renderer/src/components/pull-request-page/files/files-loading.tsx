import { PanelLeftClose } from 'lucide-react'
import { useAppStore } from '@/store/index'
import { cn } from '@/lib/class-names'
import { useTranslate } from '@/i18n/use-translate'
import {
  COMBINED_DIFF_FILE_TREE_MAX_WIDTH,
  COMBINED_DIFF_FILE_TREE_MIN_DIFF_WIDTH,
  COMBINED_DIFF_FILE_TREE_MIN_WIDTH,
  clampCombinedDiffFileTreeWidth
} from '../../../../../shared/source-control/diff/combined-diff-file-tree-width'

// Why: same shade as the checks panel skeleton (#47812); bg-muted is the sidebar's own shade in light theme.
const bar = 'block shrink-0 rounded bg-muted-foreground/15'
// Why: a fast read never flashes bars; reduced motion skips the fade and shows them at once.
const fade = 'animate-in fade-in-0 fill-mode-backwards delay-150 motion-reduce:animate-none'

// Fixed shapes: never sized to the PR and never fake file names.
// Why: row columns mirror combined-diff-file-tree-row (directory: 8 px pad, chevron + folder; file: 32 px pad, icon).
const TREE_ROWS = [
  { directory: true, width: 'w-12' },
  { directory: false, width: 'w-24' },
  { directory: false, width: 'w-20' },
  { directory: true, width: 'w-16' },
  { directory: false, width: 'w-28' }
]
const SECTIONS = [
  { path: 'w-2/5', lines: ['w-3/5', 'w-2/5', 'w-1/2', 'w-1/3', 'w-2/5', 'w-1/4'] },
  { path: 'w-1/3', lines: ['w-1/2', 'w-3/5', 'w-1/4', 'w-2/5'] },
  { path: 'w-1/2', lines: ['w-2/5', 'w-1/3', 'w-1/2'] }
]

/** The Files tab while a cold read runs: toolbar, file tree and three diff sections at the loaded geometry. */
export function PRFilesLoading(): React.JSX.Element {
  const t = useTranslate()
  const storedTreeWidth = useAppStore((s) => s.combinedDiffFileTreeWidth)
  const treeWidth = clampCombinedDiffFileTreeWidth(storedTreeWidth)
  return (
    <div
      aria-hidden="true"
      className={cn('flex h-full min-h-0 flex-1 flex-col overflow-hidden', fade)}
    >
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border bg-background px-3 py-1.5">
        <div className="flex h-6 min-w-0 items-center">
          <span className={cn(bar, 'h-2 w-28')} />
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <div className="flex h-6 w-20 items-center">
            <span className={cn(bar, 'h-2 w-14')} />
          </div>
          <div className="flex h-6 w-24 items-center justify-center rounded-md border border-border">
            <span className={cn(bar, 'h-2 w-14')} />
          </div>
        </div>
      </div>
      <div className="flex min-h-0 flex-1">
        <aside
          className="flex min-h-0 shrink-0 flex-col overflow-hidden border-r border-border bg-background"
          style={{
            // Why: mirrors computeCombinedDiffFileTreeWidthBounds in CSS so the tree lands at the width it loads at.
            width: `max(min(${COMBINED_DIFF_FILE_TREE_MIN_WIDTH}px, 50%), min(${treeWidth}px, ${COMBINED_DIFF_FILE_TREE_MAX_WIDTH}px, calc(100% - ${COMBINED_DIFF_FILE_TREE_MIN_DIFF_WIDTH}px)))`
          }}
        >
          <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-1.5">
            <div className="text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
              {t('auto.components.editor.CombinedDiffFileTree.481e63ca52', 'Files')}
            </div>
            <span className="flex size-6 shrink-0 items-center justify-center">
              <PanelLeftClose className="size-3.5" />
            </span>
          </div>
          <div className="flex items-center gap-2 border-b border-border px-2 py-2">
            <div className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md border border-input pl-2">
              <span className={cn(bar, 'size-3.5')} />
              <span className={cn(bar, 'h-2 w-20')} />
            </div>
            <span className="size-8 shrink-0 rounded-md border border-input" />
          </div>
          <div className="py-1">
            {TREE_ROWS.map((row, index) =>
              row.directory ? (
                <div key={index} className="flex h-6 items-center gap-1 pr-3 pl-2">
                  <span className={cn(bar, 'size-3')} />
                  <span className={cn(bar, 'size-3')} />
                  <span className={cn(bar, 'h-2', row.width)} />
                </div>
              ) : (
                <div key={index} className="flex h-6 items-center gap-1 pr-3 pl-8">
                  <span className={cn(bar, 'size-3.5')} />
                  <span className={cn(bar, 'h-2', row.width)} />
                </div>
              )
            )}
          </div>
        </aside>
        <div className="min-w-0 flex-1 overflow-hidden">
          {SECTIONS.map((section, index) => (
            <div key={index} className="border-b border-border">
              {/* Why: mirrors DiffSectionHeader: path and stats share the flex-1 span, then Viewed (h-6), open and chevron. */}
              <div className="flex h-9 items-center px-3">
                <span className="flex min-w-0 flex-1 items-center gap-2">
                  <span className={cn(bar, 'h-2 min-w-8 shrink', section.path)} />
                  <span className={cn(bar, 'ml-auto h-2 w-8')} />
                </span>
                <span className="ml-2 flex shrink-0 items-center gap-1">
                  <span className="flex h-6 items-center gap-1.5 px-1.5">
                    <span className={cn(bar, 'size-4 rounded-sm')} />
                    <span className={cn(bar, 'h-2 w-9')} />
                  </span>
                  <span className="p-0.5">
                    <span className={cn(bar, 'size-3.5')} />
                  </span>
                  <span className={cn(bar, 'size-3.5')} />
                </span>
              </div>
              <div className="py-2.5">
                {section.lines.map((width, line) => (
                  <div key={line} className="flex h-[19px] items-center gap-3 px-3">
                    <span className={cn(bar, 'h-2 w-5')} />
                    <span className={cn(bar, 'h-2', width)} />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
