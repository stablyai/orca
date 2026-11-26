import React from 'react'
import { HostRowIcon } from '../../host-picker/host-row-icon'
import { RunTargetRow } from './RunTargetComboboxRow'
import { RecipesSubmenuRow } from './RunTargetSubmenus'
import type {
  EphemeralVmRecipeOption,
  RunTargetHostOption,
  RunTargetRowModel
} from './run-target-options'

/** The scrolling rows of the run-target picker; Add host is pinned below them. */
export default function RunTargetRowList({
  rows,
  armedKey,
  listId,
  selectedHostId,
  selectedRecipeId,
  matchedRecipes,
  recipesOpen,
  onArm,
  onRecipesOpenChange,
  onSelectHost,
  onSelectRecipe
}: {
  rows: readonly RunTargetRowModel[]
  armedKey: string | null
  listId: string
  selectedHostId: string | null
  selectedRecipeId: string | null
  matchedRecipes: readonly EphemeralVmRecipeOption[]
  recipesOpen: boolean
  onArm: (key: string, submenu: 'recipes' | null) => void
  onRecipesOpenChange: (open: boolean) => void
  onSelectHost: (option: RunTargetHostOption) => void
  onSelectRecipe: (recipeId: string) => void
}): React.JSX.Element {
  return (
    <>
      {rows.map((row) => {
        if (row.kind === 'add-host') {
          return null
        }
        const armed = armedKey === row.key
        const optionId = armed ? `${listId}-armed` : undefined
        if (row.kind === 'host') {
          const { option } = row
          const select = () => onSelectHost(option)
          return (
            <RunTargetRow
              key={row.key}
              icon={option.icon ?? <HostRowIcon hostId={option.hostId} />}
              label={option.label}
              detail={option.detail}
              description={option.description}
              armed={armed}
              current={option.id === selectedHostId}
              dimmed={!option.available}
              disabled={!option.onSelect && !option.trailing}
              optionId={optionId}
              onArm={() => onArm(row.key, null)}
              onCommit={select}
              trailing={option.trailing?.(select)}
            />
          )
        }
        return (
          <RecipesSubmenuRow
            key={row.key}
            open={recipesOpen}
            onOpenChange={onRecipesOpenChange}
            armed={armed}
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
