import React from 'react'
import type {
  NeedsSetupProjectHostOption,
  ReadyProjectHostSetupOption
} from '@/lib/project-host-setup-options'
import { HostRowIcon, RunTargetRow } from './RunTargetComboboxRow'
import { ConnectHostButton, NeedsSetupHostIcon, SetLocationButton } from './RunTargetRowActions'
import { RecipesSubmenuRow, type RunTargetSubmenuArm } from './RunTargetSubmenus'
import { RunTargetOrcaCloudRow } from './RunTargetOrcaCloudRow'
import type { OrcaCloudRunTargetAccess } from './orca-cloud-run-target-access'
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
  recipesSubmenuArm,
  orcaCloudAccess,
  connectingHostIds,
  canConnect,
  canSetLocation,
  onArm,
  onRecipesOpenChange,
  onSelectHost,
  onSelectRecipe,
  onSelectOrcaCloud,
  onOrcaCloudBlockedAction,
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
  recipesSubmenuArm: RunTargetSubmenuArm
  orcaCloudAccess: OrcaCloudRunTargetAccess
  connectingHostIds: ReadonlySet<string>
  canConnect: boolean
  canSetLocation: boolean
  /** Arms a row and opens the submenu that row owns, if any. */
  onArm: (key: string, submenu: 'recipes' | null) => void
  onRecipesOpenChange: (open: boolean) => void
  onSelectHost: (option: ReadyProjectHostSetupOption) => void
  onSelectRecipe: (recipeId: string) => void
  onSelectOrcaCloud: (recipe: EphemeralVmRecipeOption | null) => void
  /** Plans or billing, for an account that cannot start a sandbox. */
  onOrcaCloudBlockedAction: () => void
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
        if (row.kind === 'orca-cloud') {
          return (
            <RunTargetOrcaCloudRow
              key={row.key}
              recipe={row.recipe}
              access={orcaCloudAccess}
              armed={isArmed}
              current={row.recipe !== null && row.recipe.id === selectedRecipeId}
              optionId={optionId}
              onArm={() => onArm(row.key, null)}
              onSelect={() => onSelectOrcaCloud(row.recipe)}
              onBlockedAction={onOrcaCloudBlockedAction}
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
              // Inline Connect/Set location already provides the next step; omit duplicate detail text.
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
        return (
          <RecipesSubmenuRow
            key={row.key}
            open={recipesOpen}
            onOpenChange={onRecipesOpenChange}
            armed={isArmed}
            optionId={optionId}
            recipes={matchedRecipes}
            selectedRecipeId={selectedRecipeId}
            submenuArm={recipesSubmenuArm}
            onArm={() => onArm(row.key, 'recipes')}
            onSelectRecipe={onSelectRecipe}
          />
        )
      })}
    </>
  )
}
