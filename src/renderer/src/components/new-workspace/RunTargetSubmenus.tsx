import React from 'react'
import { Box, Boxes, ChevronDown, Network, Plus, Server } from 'lucide-react'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { useTranslate } from '@/i18n/use-translate'
import { RunTargetRow } from './RunTargetComboboxRow'
import {
  getEphemeralVmLabel,
  getRecipeDetail,
  getRecipeSubmenuItemKey,
  RUN_TARGET_ADD_HOST_KEY,
  RUN_TARGET_ADD_REMOTE_SERVER_ITEM,
  RUN_TARGET_ADD_SSH_HOST_ITEM,
  type EphemeralVmRecipeOption
} from './run-target-options'
import { COMBOBOX_POPOVER_SURFACE } from './type-ahead-combobox-styles'

const SUBMENU_CONTENT = cn('w-72 p-1', COMBOBOX_POPOVER_SURFACE)

/** Keyboard/pointer arm inside a submenu; the combobox input points `aria-activedescendant` at it. */
export type RunTargetSubmenuArm = {
  /** The submenu listbox id, so the input can list it in `aria-controls`. */
  listId: string
  armedItemKey: string | null
  optionIdFor: (key: string) => string
  onArmItem: (key: string | null) => void
}

/** Keeps the keyboard-armed submenu row visible in a long list. */
function useScrollArmedIntoView(arm: RunTargetSubmenuArm): void {
  const { armedItemKey, optionIdFor } = arm
  React.useEffect(() => {
    if (armedItemKey) {
      document.getElementById(optionIdFor(armedItemKey))?.scrollIntoView({ block: 'nearest' })
    }
  }, [armedItemKey, optionIdFor])
}

const SUBMENU_LIST = 'max-h-72 overflow-y-auto scrollbar-sleek'

/** The "Per-Workspace Environment" row and its nested recipe list. */
export function RecipesSubmenuRow({
  open,
  onOpenChange,
  armed,
  armedInSubmenu,
  optionId,
  recipes,
  selectedRecipeId,
  submenuArm,
  onArm,
  onSelectRecipe
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  armed: boolean
  /** Keyboard focus is inside this submenu; the parent keeps a lighter fill. */
  armedInSubmenu: boolean
  optionId: string
  recipes: readonly EphemeralVmRecipeOption[]
  selectedRecipeId: string | null
  submenuArm: RunTargetSubmenuArm
  onArm: () => void
  onSelectRecipe: (recipeId: string) => void
}): React.JSX.Element {
  const t = useTranslate()
  useScrollArmedIntoView(submenuArm)
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverAnchor asChild>
        <div>
          <RunTargetRow
            icon={<Boxes className="size-3.5 shrink-0 text-muted-foreground" />}
            label={getEphemeralVmLabel(t)}
            detail={t(
              'auto.components.NewWorkspaceComposerCard.customEnvironmentsHint',
              'Create a workspace from an orca.yaml recipe'
            )}
            armed={armed}
            armedInSubmenu={armedInSubmenu}
            current={selectedRecipeId !== null && recipes.some((r) => r.id === selectedRecipeId)}
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
        {/* Hover arms like a native menu; leaving keeps the arm so keyboard users keep their place. */}
        <div
          id={submenuArm.listId}
          role="listbox"
          aria-label={getEphemeralVmLabel(t)}
          className={SUBMENU_LIST}
        >
          {recipes.map((recipe) => {
            const key = getRecipeSubmenuItemKey(recipe.id)
            return (
              <RunTargetRow
                key={recipe.id}
                icon={<Box className="size-3.5 shrink-0 text-muted-foreground" />}
                label={recipe.name}
                detail={getRecipeDetail(recipe, t)}
                armed={submenuArm.armedItemKey === key}
                current={recipe.id === selectedRecipeId}
                optionId={submenuArm.optionIdFor(key)}
                onArm={() => submenuArm.onArmItem(key)}
                onCommit={() => onSelectRecipe(recipe.id)}
              />
            )
          })}
        </div>
      </PopoverContent>
    </Popover>
  )
}

/** Pin Add host so scrolling, filtering and empty results cannot hide it. */
export function AddHostSubmenuRow({
  open,
  onOpenChange,
  armed,
  armedInSubmenu,
  optionId,
  submenuArm,
  onArm,
  onAddSshHost,
  onAddRemoteServer
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  armed: boolean
  armedInSubmenu: boolean
  optionId: string
  submenuArm: RunTargetSubmenuArm
  onArm: () => void
  onAddSshHost?: () => void
  onAddRemoteServer?: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const addHostLabel = t('auto.components.NewWorkspaceComposerCard.addHost', 'Add host')
  useScrollArmedIntoView(submenuArm)
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverAnchor asChild>
        <div
          role="option"
          id={optionId}
          aria-selected={armed}
          // `option` supports aria-haspopup but not aria-expanded; the submenu is a listbox.
          aria-haspopup="listbox"
          data-armed={armed || undefined}
          data-run-target-add-host="true"
          onMouseDown={(event) => event.preventDefault()}
          onMouseMove={onArm}
          onClick={() => onOpenChange(true)}
          className={cn(
            'flex h-9 shrink-0 cursor-default items-center gap-2 border-t border-border px-3 text-sm',
            armed &&
              (armedInSubmenu
                ? 'bg-accent/30 ring-1 ring-inset ring-border'
                : 'bg-accent text-accent-foreground')
          )}
        >
          <span className="flex w-4 shrink-0 items-center justify-center">
            <Plus className="size-3.5 text-muted-foreground" />
          </span>
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
        <div
          id={submenuArm.listId}
          role="listbox"
          aria-label={addHostLabel}
          className={SUBMENU_LIST}
        >
          {onAddSshHost ? (
            <RunTargetRow
              icon={<Server className="size-3.5 shrink-0 text-muted-foreground" />}
              label={t('auto.components.NewWorkspaceComposerCard.addSshHost', 'Add SSH host')}
              detail={t(
                'auto.components.NewWorkspaceComposerCard.addSshHostHint',
                'Use an existing machine over SSH'
              )}
              armed={submenuArm.armedItemKey === RUN_TARGET_ADD_SSH_HOST_ITEM}
              current={false}
              stacked
              optionId={submenuArm.optionIdFor(RUN_TARGET_ADD_SSH_HOST_ITEM)}
              onArm={() => submenuArm.onArmItem(RUN_TARGET_ADD_SSH_HOST_ITEM)}
              onCommit={onAddSshHost}
            />
          ) : null}
          {onAddRemoteServer ? (
            <RunTargetRow
              icon={<Network className="size-3.5 shrink-0 text-muted-foreground" />}
              label={t(
                'auto.components.NewWorkspaceComposerCard.addRemoteOrcaServerSentence',
                'Add remote Orca server'
              )}
              detail={t(
                'auto.components.NewWorkspaceComposerCard.connectOrcaOnAnotherComputer',
                'Connect to Orca on another computer'
              )}
              armed={submenuArm.armedItemKey === RUN_TARGET_ADD_REMOTE_SERVER_ITEM}
              current={false}
              stacked
              optionId={submenuArm.optionIdFor(RUN_TARGET_ADD_REMOTE_SERVER_ITEM)}
              onArm={() => submenuArm.onArmItem(RUN_TARGET_ADD_REMOTE_SERVER_ITEM)}
              onCommit={onAddRemoteServer}
            />
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  )
}

export { RUN_TARGET_ADD_HOST_KEY }
