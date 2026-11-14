import type React from 'react'
import { CommandItem } from '@/components/ui/command'
import { formatPaletteSessionAge } from '@/components/cmd-j/palette-session-age'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import type { ExtraPaletteItem } from './worktree-jump-palette-model'
import type { WorktreeJumpPaletteController } from './use-worktree-jump-palette-controller'
import { PaletteOpenTabPrimaryLine } from './worktree-jump-palette-primitives'

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
        <div className="min-w-0 flex-1">
          <PaletteOpenTabPrimaryLine
            title={result.title}
            titleRanges={result.titleRanges}
            secondaryText=""
            secondaryRanges={[]}
            secondary={result.line}
            sessionAge={formatPaletteSessionAge(result.lastActiveAt, controller.paletteNowMs, t)}
          />
        </div>
        {result.trailing ? (
          <div className="flex max-w-[40%] shrink-0 items-center gap-1.5">{result.trailing}</div>
        ) : null}
      </div>
    </CommandItem>
  )
}
