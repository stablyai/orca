import type React from 'react'
import { CommandOption } from '@/components/ui/command'
import { formatPaletteSessionAge } from '@/components/cmd-j/palette-session-age'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import type { ExtraPaletteItem } from './worktree-jump-palette-model'
import type { WorktreeJumpPaletteController } from './use-worktree-jump-palette-controller'
import { PaletteOpenTabPrimaryLine } from './worktree-jump-palette-primitives'

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
    <CommandOption
      {...controller.getOptionProps(renderKey)}
      onSelect={() => controller.handleSelectItem(entry)}
      selection="palette"
      className="mx-0.5 cursor-pointer"
    >
      <div
        className={cn(
          'flex w-full min-w-0 items-center gap-3 px-1 py-1',
          result.dimmed && 'opacity-60'
        )}
      >
        {result.leading ? (
          <div className="flex shrink-0 items-center justify-center self-start">
            {result.leading}
          </div>
        ) : null}
        <div className="min-w-0 flex-1 overflow-hidden">
          <PaletteOpenTabPrimaryLine
            title={result.title}
            titleRanges={result.titleRanges}
            secondaryText=""
            secondaryRanges={[]}
            sessionAge={sessionAge}
          />
          {result.line ? (
            <div className="mt-0.5 min-w-0 truncate text-[12px] text-muted-foreground">
              {result.line}
            </div>
          ) : null}
        </div>
        {result.trailing ? (
          <div className="flex shrink-0 items-center gap-1.5">{result.trailing}</div>
        ) : null}
      </div>
    </CommandOption>
  )
}
