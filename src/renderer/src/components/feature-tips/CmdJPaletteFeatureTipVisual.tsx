import type { JSX } from 'react'
import { Search, SlidersHorizontal, SquareTerminal } from 'lucide-react'
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion'
import { useShortcutKeys } from '@/hooks/useShortcutLabel'

type PaletteRow = {
  key: string
  title: string
  chip: string
  skeletonWidth: string
  /** Per-row selection sweep timing; the highlight steps down the list in turn. */
  highlightClass: string
}

const PALETTE_ROWS: readonly PaletteRow[] = [
  {
    key: 'worktree',
    title: 'auth-refresh',
    chip: 'Current',
    skeletonWidth: '64%',
    highlightClass: 'animate-cmd-j-tip-row-1'
  },
  {
    key: 'settings',
    title: 'Shortcuts',
    chip: 'Settings',
    skeletonWidth: '52%',
    highlightClass: 'animate-cmd-j-tip-row-2'
  },
  {
    key: 'action',
    title: 'New Terminal Tab',
    chip: 'Action',
    skeletonWidth: '46%',
    highlightClass: 'animate-cmd-j-tip-row-3'
  }
]

function RowIcon({ rowKey }: { rowKey: string }): JSX.Element {
  if (rowKey === 'worktree') {
    return <span className="size-[7px] rounded-full bg-green-500" />
  }
  if (rowKey === 'settings') {
    return <SlidersHorizontal className="size-3.5 text-muted-foreground/85" />
  }
  return <SquareTerminal className="size-3.5 text-muted-foreground/85" />
}

export function CmdJPaletteFeatureTipVisual(): JSX.Element {
  const reducedMotion = usePrefersReducedMotion()
  // Why: render the live binding so the cue stays correct after a rebind and on
  // platforms where Cmd+J is not the default (Linux/Windows use Ctrl+Shift+J).
  const shortcutKeys = useShortcutKeys('worktree.palette')

  return (
    <div className="flex w-full flex-col items-center gap-3" aria-hidden="true">
      {shortcutKeys.length > 0 ? (
        <div className="inline-flex items-center gap-1.5">
          {shortcutKeys.map((key, index) => (
            <span
              key={`${key}-${index}`}
              className={`inline-flex h-7 min-w-7 items-center justify-center rounded-md border border-border/80 bg-foreground/[0.08] px-2 text-xs font-semibold text-muted-foreground shadow-xs ${
                reducedMotion ? '' : 'animate-cmd-j-tip-keypress'
              }`}
              style={reducedMotion ? undefined : { animationDelay: `${index * 0.08}s` }}
            >
              {key}
            </span>
          ))}
        </div>
      ) : null}

      <div
        className={`w-full max-w-[19rem] overflow-hidden rounded-xl border border-border bg-card text-left shadow-lg ${
          reducedMotion ? '' : 'animate-cmd-j-tip-palette'
        }`}
      >
        <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
          <Search className="size-[14px] shrink-0 text-muted-foreground" />
          <span className="truncate text-[12px] text-muted-foreground/75">
            Search workspaces, settings, actions…
          </span>
        </div>
        <div className="flex flex-col gap-0.5 p-1.5">
          {PALETTE_ROWS.map((row) => (
            <div
              key={row.key}
              className={`flex items-center gap-2.5 rounded-lg border border-transparent px-2.5 py-2 ${
                reducedMotion ? '' : row.highlightClass
              }`}
            >
              <span className="flex w-4 shrink-0 items-center justify-center">
                <RowIcon rowKey={row.key} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-[12.5px] font-semibold tracking-[-0.01em] text-foreground">
                    {row.title}
                  </span>
                  <span className="shrink-0 rounded-[6px] border border-border/60 bg-background/45 px-1.5 py-px text-[9px] font-medium leading-normal text-muted-foreground/88">
                    {row.chip}
                  </span>
                </div>
                <span
                  className="mt-1.5 block h-1.5 rounded-sm bg-foreground/[0.14]"
                  style={{ width: row.skeletonWidth }}
                />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
