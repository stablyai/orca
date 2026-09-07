import type React from 'react'
import { FolderTree } from 'lucide-react'
import { CommandItem } from '@/components/ui/command'
import { RepoBadgeMark } from '@/components/repo/RepoBadgeLabel'
import { getPaletteHostBadge } from '@/components/cmd-j/palette-host-badge'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type {
  ProjectTargetPaletteItem,
  QuickActionPaletteItem,
  SettingsPaletteItem
} from './worktree-jump-palette-model'
import type { WorktreeJumpPaletteController } from './use-worktree-jump-palette-controller'
import { PaletteHostBadgeChip } from './worktree-jump-palette-primitives'

export function WorktreeJumpPaletteProjectRow({
  entry,
  renderKey,
  controller
}: {
  entry: ProjectTargetPaletteItem
  renderKey: string
  controller: WorktreeJumpPaletteController
}): React.JSX.Element {
  const result = entry.result
  const isProject = result.kind === 'project'
  const hostBadge = isProject
    ? getPaletteHostBadge(result.repo, controller.hostOptions, controller.hostFilterActive)
    : null
  const badgeLabel = isProject
    ? translate('auto.components.WorktreeJumpPalette.projectBadge', 'Project')
    : translate('auto.components.WorktreeJumpPalette.repoGroupBadge', 'Repo group')

  return (
    <CommandItem
      value={renderKey}
      onSelect={() => controller.handleSelectItem(entry)}
      className={cn(
        'group mx-0.5 flex cursor-pointer items-center gap-3 rounded-lg border border-transparent px-3 py-2.5 text-left outline-none transition-[background-color,border-color,box-shadow]',
        'data-[selected=true]:border-border data-[selected=true]:bg-accent data-[selected=true]:text-foreground'
      )}
    >
      <div className="flex h-5 w-4 shrink-0 items-center justify-center self-start text-muted-foreground/85">
        <FolderTree className="size-3.5" aria-hidden="true" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2.5">
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <span className="truncate text-[14px] font-semibold text-foreground">
                {result.title}
              </span>
              <span className="shrink-0 rounded-[6px] border border-border/60 bg-background/45 px-1.5 py-px text-[9px] font-medium leading-normal text-muted-foreground/88">
                {badgeLabel}
              </span>
            </div>
          </div>
          {isProject ? (
            <div className="flex shrink-0 items-center gap-1.5">
              <PaletteHostBadgeChip badge={hostBadge} />
              <span className="inline-flex max-w-[180px] items-center gap-1.5 rounded-md border border-border bg-muted px-2 py-1 text-[11px] font-semibold leading-none text-foreground">
                <RepoBadgeMark color={result.repo.badgeColor} />
                <span className="truncate">{result.repo.displayName}</span>
              </span>
            </div>
          ) : null}
        </div>
      </div>
    </CommandItem>
  )
}

export function WorktreeJumpPaletteActionRow({
  entry,
  renderKey,
  controller
}: {
  entry: SettingsPaletteItem | QuickActionPaletteItem
  renderKey: string
  controller: WorktreeJumpPaletteController
}): React.JSX.Element {
  const result = entry.result
  const Icon = result.icon
  const kindLabel =
    entry.type === 'settings'
      ? translate('auto.components.WorktreeJumpPalette.settingsBadge', 'Settings')
      : translate('auto.components.WorktreeJumpPalette.actionBadge', 'Action')

  return (
    <CommandItem
      value={renderKey}
      onSelect={() => controller.handleSelectItem(entry)}
      className={cn(
        'group mx-0.5 flex cursor-pointer items-center gap-3 rounded-lg border border-transparent px-3 py-2.5 text-left outline-none transition-[background-color,border-color,box-shadow]',
        'data-[selected=true]:border-border data-[selected=true]:bg-accent data-[selected=true]:text-foreground'
      )}
    >
      <div className="flex h-5 w-4 shrink-0 items-center justify-center self-start text-muted-foreground/85">
        <Icon className="size-3.5" aria-hidden="true" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-[14px] font-semibold tracking-[-0.01em] text-foreground">
            {result.title}
          </span>
          <span className="shrink-0 rounded-[6px] border border-border/60 bg-background/45 px-1.5 py-px text-[9px] font-medium leading-normal text-muted-foreground/88">
            {kindLabel}
          </span>
        </div>
        <div className="mt-1 truncate text-[12px] leading-5 text-muted-foreground/88">
          {result.description}
        </div>
      </div>
    </CommandItem>
  )
}
