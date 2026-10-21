import React from 'react'
import type {
  NeedsSetupProjectHostOption,
  ReadyProjectHostSetupOption
} from '@/lib/project-host-setup-options'
import { HostRowIcon, RunTargetRow } from './RunTargetComboboxRow'
import { ConnectHostButton, NeedsSetupHostIcon, SetLocationButton } from './RunTargetRowActions'
import { RecipesSubmenuRow } from './RunTargetSubmenus'
import type { EphemeralVmRecipeOption, RunTargetRowModel } from './run-target-options'

/** The scrolling rows of the run-target picker; "Add host" is pinned outside this list. */
export default function RunTargetRowList({
  rows,
  armedKey,
  listId,
  selectedHost,
  selectedRecipeId,
  matchedRecipes,
  recipesOpen,
  connectingHostIds,
  canConnect,
  canSetLocation,
  onArm,
  onRecipesOpenChange,
  onSelectHost,
  onSelectRecipe,
  onConnectHost,
  onSetLocation
}: {
  rows: readonly RunTargetRowModel[]
  armedKey: string | null
  listId: string
  /** The committed host, or null while a recipe holds the selection. */
  selectedHost: ReadyProjectHostSetupOption | null
  selectedRecipeId: string | null
  matchedRecipes: readonly EphemeralVmRecipeOption[]
  recipesOpen: boolean
  connectingHostIds: ReadonlySet<string>
  canConnect: boolean
  canSetLocation: boolean
  /** Arms a row and opens the submenu that row owns, if any. */
  onArm: (key: string, submenu: 'recipes' | null) => void
  onRecipesOpenChange: (open: boolean) => void
  onSelectHost: (option: ReadyProjectHostSetupOption) => void
  onSelectRecipe: (recipeId: string) => void
  onConnectHost: (option: NeedsSetupProjectHostOption) => void
  onSetLocation: (option: NeedsSetupProjectHostOption) => void
}): React.JSX.Element {
  return (
    <>
      {rows.map((row) => {
        if (row.kind === 'add-host') {
          return null
        }
        const isArmed = armedKey === row.key
        const optionId = isArmed ? `${listId}-armed` : undefined
        if (row.kind === 'ready') {
          return (
            <RunTargetRow
              key={row.key}
              icon={<HostRowIcon hostId={row.option.hostId} />}
              label={row.option.label}
              detail={row.option.path}
              armed={isArmed}
              current={row.option === selectedHost}
              optionId={optionId}
              onArm={() => onArm(row.key, null)}
              onCommit={() => onSelectHost(row.option)}
            />
          )
        }
        if (row.kind === 'needs-setup') {
          const connecting = connectingHostIds.has(row.option.hostId)
          const hasConnect = Boolean(row.option.connectAction && canConnect)
          const hasSetLocation = Boolean(row.option.canSetLocation && canSetLocation)
          return (
            <RunTargetRow
              key={row.key}
              icon={
                <NeedsSetupHostIcon
                  hostId={row.option.hostId}
                  connecting={connecting}
                  attention={row.option.attention}
                />
              }
              label={row.option.label}
              // Why: Connect / Set project location already say the next
              // step, so the detail line would only repeat that.
              detail={hasConnect || hasSetLocation ? '' : row.option.detail}
              armed={isArmed}
              current={false}
              dimmed
              optionId={optionId}
              onArm={() => onArm(row.key, null)}
              onCommit={() => onSetLocation(row.option)}
              trailing={
                hasConnect ? (
                  <ConnectHostButton
                    connecting={connecting}
                    onConnect={() => onConnectHost(row.option)}
                  />
                ) : hasSetLocation ? (
                  <SetLocationButton
                    hostLabel={row.option.label}
                    onSetLocation={() => onSetLocation(row.option)}
                  />
                ) : undefined
              }
            />
          )
        }
        // Recipes submenu row.
        return (
          <RecipesSubmenuRow
            key={row.key}
            open={recipesOpen}
            onOpenChange={onRecipesOpenChange}
            armed={isArmed}
            optionId={optionId}
            recipes={matchedRecipes}
            selectedRecipeId={selectedRecipeId}
            onArm={() => onArm(row.key, 'recipes')}
            onSelectRecipe={onSelectRecipe}
          />
        )
      })}
    </>
  )
}
