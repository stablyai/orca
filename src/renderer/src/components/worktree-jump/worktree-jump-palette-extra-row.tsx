import type React from 'react'
import { CommandItem } from '@/components/ui/command'
import { formatPaletteSessionAge } from '@/components/cmd-j/palette-session-age'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import type { ExtraPaletteItem } from './worktree-jump-palette-model'
import type { WorktreeJumpPaletteController } from './use-worktree-jump-palette-controller'
import { HighlightedText } from './worktree-jump-palette-primitives'

/** One line in the workspace row's box, so titles share a column with tab and workspace rows. */
export function WorktreeJumpPaletteExtraRow({
  entry,
  renderKey,
  controller
}: {
  entry: ExtraPaletteItem
  renderKey: string
  controller: WorktreeJumpPaletteController
}): React.JSX.Element {
  const t = useTranslate()
  const { result } = entry
  const sessionAge = formatPaletteSessionAge(result.lastActiveAt, controller.paletteNowMs, t)
  return (
    <CommandItem
      value={renderKey}
      onSelect={() => controller.handleSelectItem(entry)}
      shape="palette-row"
    >
      <div className={cn('flex min-w-0 flex-1 items-center gap-3', result.dimmed && 'opacity-60')}>
        <div className="flex h-5 w-4 shrink-0 items-center justify-center self-start">
          {result.leading}
        </div>
        <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
          <span
            className={cn(
              'truncate text-[14px] font-semibold tracking-[-0.01em] text-foreground',
              result.line ? 'max-w-[62%] shrink-0' : 'min-w-0'
            )}
          >
            <HighlightedText text={result.title} matchRanges={result.titleRanges} />
          </span>
          {sessionAge ? (
            <span
              aria-label={t(
                'auto.components.WorktreeJumpPalette.lastActiveTime',
                'Last active {{value0}} ago',
                { value0: sessionAge }
              )}
              className="shrink-0 text-[11px] font-medium tabular-nums text-muted-foreground/70"
            >
              {sessionAge}
            </span>
          ) : null}
          {result.line ? (
            <>
              <span className="shrink-0 text-muted-foreground/45">·</span>
              <span className="min-w-0 truncate text-[12px] text-muted-foreground/92">
                {result.line}
              </span>
            </>
          ) : null}
        </div>
        {result.trailing ? (
          <div className="flex max-w-[40%] shrink-0 items-center gap-1.5">{result.trailing}</div>
        ) : null}
      </div>
    </CommandItem>
  )
}
