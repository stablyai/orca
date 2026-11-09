import React from 'react'
import { Box, Boxes, ChevronDown, Network, Plus, Server, Sparkles } from 'lucide-react'
import { useBillingSummary } from '@/components/billing/billing-summary-store'
import { openPlansPage } from '@/components/billing/plans/plans-page-store'
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
  armedItemId: string
  onArmItem: (key: string | null) => void
}

function itemId(arm: RunTargetSubmenuArm, key: string): string | undefined {
  return arm.armedItemKey === key ? arm.armedItemId : undefined
}

/** The "Per-Workspace Environment" row and its nested recipe list. */
export function RecipesSubmenuRow({
  open,
  onOpenChange,
  armed,
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
  optionId: string | undefined
  recipes: readonly EphemeralVmRecipeOption[]
  selectedRecipeId: string | null
  submenuArm: RunTargetSubmenuArm
  onArm: () => void
  onSelectRecipe: (recipeId: string) => void
}): React.JSX.Element {
  const t = useTranslate()
  const billing = useBillingSummary()
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
        <div id={submenuArm.listId} role="listbox" aria-label={getEphemeralVmLabel(t)}>
          {recipes.map((recipe) => {
            const key = getRecipeSubmenuItemKey(recipe.id)
            // Orca Cloud without a plan: the row explains and leads to plans instead of failing later.
            const needsPlan = recipe.provider === 'orca-cloud' && billing.subscribed === false
            return (
              <RunTargetRow
                key={recipe.id}
                icon={<Box className="size-3.5 shrink-0 text-muted-foreground" />}
                label={recipe.name}
                detail={
                  needsPlan
                    ? billing.canManageBilling
                      ? t(
                          'auto.components.NewWorkspaceComposerCard.orcaCloudUpgrade',
                          'Upgrade to run agents in the cloud'
                        )
                      : t(
                          'auto.components.NewWorkspaceComposerCard.orcaCloudAskAdmin',
                          'Needs a plan. Ask an owner or admin to upgrade.'
                        )
                    : getRecipeDetail(recipe, t)
                }
                armed={submenuArm.armedItemKey === key}
                current={recipe.id === selectedRecipeId}
                optionId={itemId(submenuArm, key)}
                onArm={() => submenuArm.onArmItem(key)}
                onCommit={() => {
                  if (needsPlan) {
                    onOpenChange(false)
                    openPlansPage('run-on')
                  } else {
                    onSelectRecipe(recipe.id)
                  }
                }}
                trailing={
                  needsPlan ? (
                    <span className="ml-auto inline-flex shrink-0 items-center gap-1 self-center rounded-full border border-border bg-background px-1.5 py-px text-[10px] font-medium text-foreground">
                      <Sparkles className="size-2.5" />
                      {t('auto.components.NewWorkspaceComposerCard.upgradePill', 'Upgrade')}
                    </span>
                  ) : undefined
                }
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
  optionId,
  submenuArm,
  onArm,
  onAddSshHost,
  onAddRemoteServer
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  armed: boolean
  optionId: string | undefined
  submenuArm: RunTargetSubmenuArm
  onArm: () => void
  onAddSshHost?: () => void
  onAddRemoteServer?: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const addHostLabel = t('auto.components.NewWorkspaceComposerCard.addHost', 'Add host')
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
            armed && 'bg-accent text-accent-foreground'
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
        <div id={submenuArm.listId} role="listbox" aria-label={addHostLabel}>
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
              optionId={itemId(submenuArm, RUN_TARGET_ADD_SSH_HOST_ITEM)}
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
                'auto.components.NewWorkspaceComposerCard.addRemoteOrcaServerHint',
                'Pair another Orca runtime'
              )}
              armed={submenuArm.armedItemKey === RUN_TARGET_ADD_REMOTE_SERVER_ITEM}
              current={false}
              stacked
              optionId={itemId(submenuArm, RUN_TARGET_ADD_REMOTE_SERVER_ITEM)}
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
