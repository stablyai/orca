import { CircleDot } from 'lucide-react'
import { CommandItem } from '@/components/ui/command'
import type { TaskPaletteItem } from './worktree-jump-palette-model'
import type { WorktreeJumpPaletteController } from './use-worktree-jump-palette-controller'

export function WorktreeJumpPaletteTaskRow({
  entry,
  renderKey,
  controller
}: {
  entry: TaskPaletteItem
  renderKey: string
  controller: WorktreeJumpPaletteController
}) {
  const result = entry.result
  return (
    <CommandItem
      value={renderKey}
      onSelect={() => controller.handleSelectItem(entry)}
      selection="palette"
      className="group mx-0.5 cursor-pointer text-left"
    >
      <div className="flex w-full min-w-0 items-center gap-3 py-1">
        <CircleDot className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="shrink-0 text-xs text-muted-foreground">{result.identifier}</span>
            <span className="truncate text-[14px] font-semibold text-foreground">
              {result.title}
            </span>
          </div>
          <div className="mt-1 truncate text-xs text-muted-foreground">
            {result.task.provider} · {result.sourceContext.accountLabel ?? result.hostLabel} ·{' '}
            {result.status}
          </div>
        </div>
      </div>
    </CommandItem>
  )
}
