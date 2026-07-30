import React from 'react'
import { ChevronDown, Cloud, Plus, Server } from 'lucide-react'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { RunTargetRow } from './RunTargetComboboxRow'
import {
  getEphemeralVmLabel,
  getRecipeDetail,
  RUN_TARGET_ADD_HOST_KEY,
  type EphemeralVmRecipeOption
} from './run-target-options'
import { COMBOBOX_POPOVER_SURFACE } from './type-ahead-combobox-styles'

const SUBMENU_CONTENT = cn('w-72 p-1', COMBOBOX_POPOVER_SURFACE)

/** The "Per-Workspace Environment" row and its nested recipe list. */
export function RecipesSubmenuRow({
  open,
  onOpenChange,
  armed,
  optionId,
  recipes,
  selectedRecipeId,
  onArm,
  onSelectRecipe
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  armed: boolean
  optionId: string | undefined
  recipes: readonly EphemeralVmRecipeOption[]
  selectedRecipeId: string | null
  onArm: () => void
  onSelectRecipe: (recipeId: string) => void
}): React.JSX.Element {
  const [hoveredKey, setHoveredKey] = React.useState<string | null>(null)
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverAnchor asChild>
        <div>
          <RunTargetRow
            icon={<Cloud className="size-3.5 shrink-0 text-muted-foreground" />}
            label={getEphemeralVmLabel()}
            detail={translate(
              'auto.components.NewWorkspaceComposerCard.perWorkspaceEnvHint',
              'Provision an on-demand environment from a recipe'
            )}
            armed={armed}
            current={selectedRecipeId !== null}
            optionId={optionId}
            submenu
            onArm={onArm}
            onCommit={() => onOpenChange(true)}
          />
        </div>
      </PopoverAnchor>
      <PopoverContent
        side="right"
        align="start"
        sideOffset={6}
        className={SUBMENU_CONTENT}
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        {/* Why: submenu rows track their own hover — without it they were the
            only rows in either picker that never highlighted under the pointer. */}
        <div
          role="listbox"
          aria-label={getEphemeralVmLabel()}
          onMouseLeave={() => setHoveredKey(null)}
        >
          {recipes.map((recipe) => (
            <RunTargetRow
              key={recipe.id}
              icon={<Cloud className="size-3.5 shrink-0 text-muted-foreground" />}
              label={recipe.name}
              detail={getRecipeDetail(recipe)}
              armed={hoveredKey === recipe.id}
              current={recipe.id === selectedRecipeId}
              optionId={undefined}
              onArm={() => setHoveredKey(recipe.id)}
              onCommit={() => onSelectRecipe(recipe.id)}
            />
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}

/**
 * "Add host", pinned to the popover edge so it stays reachable in every state —
 * scrolled, filtered to nothing, or with no hosts at all.
 */
export function AddHostSubmenuRow({
  open,
  onOpenChange,
  armed,
  optionId,
  onArm,
  onAddSshHost,
  onAddRemoteServer
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  armed: boolean
  optionId: string | undefined
  onArm: () => void
  onAddSshHost?: () => void
  onAddRemoteServer?: () => void
}): React.JSX.Element {
  const [hoveredKey, setHoveredKey] = React.useState<string | null>(null)
  const addHostLabel = translate('auto.components.NewWorkspaceComposerCard.addHost', 'Add host')
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverAnchor asChild>
        <div
          role="option"
          id={optionId}
          aria-selected={armed}
          // `option` supports aria-haspopup but not aria-expanded.
          aria-haspopup="menu"
          data-armed={armed || undefined}
          data-run-target-add-host="true"
          onMouseDown={(event) => event.preventDefault()}
          onMouseMove={onArm}
          onClick={() => onOpenChange(true)}
          className={cn(
            'flex h-9 shrink-0 cursor-default items-center gap-2 border-t border-border px-2 text-sm',
            armed && 'bg-accent text-accent-foreground'
          )}
        >
          <Plus className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate">{addHostLabel}</span>
          <span className="ml-auto flex shrink-0 items-center">
            <ChevronDown className="size-3.5 -rotate-90 text-muted-foreground" />
          </span>
        </div>
      </PopoverAnchor>
      <PopoverContent
        side="right"
        align="end"
        sideOffset={6}
        className={SUBMENU_CONTENT}
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <div role="listbox" aria-label={addHostLabel} onMouseLeave={() => setHoveredKey(null)}>
          {onAddSshHost ? (
            <RunTargetRow
              icon={<Server className="size-3.5 shrink-0 text-muted-foreground" />}
              label={translate(
                'auto.components.NewWorkspaceComposerCard.addSshHost',
                'Add SSH host'
              )}
              detail={translate(
                'auto.components.NewWorkspaceComposerCard.addSshHostHint',
                'Use an existing machine over SSH'
              )}
              armed={hoveredKey === 'ssh'}
              current={false}
              stacked
              optionId={undefined}
              onArm={() => setHoveredKey('ssh')}
              onCommit={onAddSshHost}
            />
          ) : null}
          {onAddRemoteServer ? (
            <RunTargetRow
              icon={<Cloud className="size-3.5 shrink-0 text-muted-foreground" />}
              label={translate(
                'auto.components.NewWorkspaceComposerCard.addRemoteOrcaServer',
                'Add Remote Orca Server'
              )}
              detail={translate(
                'auto.components.NewWorkspaceComposerCard.addRemoteOrcaServerHint',
                'Pair another Orca runtime'
              )}
              armed={hoveredKey === 'remote'}
              current={false}
              stacked
              optionId={undefined}
              onArm={() => setHoveredKey('remote')}
              onCommit={onAddRemoteServer}
            />
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  )
}

export { RUN_TARGET_ADD_HOST_KEY }
