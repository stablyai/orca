import React, { useCallback, useMemo, useState } from 'react'
import { Popover, PopoverContent } from '@/components/ui/popover'
import { cn } from '@/lib/class-names'
import { useTranslate } from '@/i18n/use-translate'
import { isWithinComboboxRoot, useTypeAheadCombobox } from '../type-ahead/use-type-ahead-combobox'
import { COMBOBOX_POPOVER_SURFACE } from '../type-ahead/type-ahead-combobox-styles'
import {
  buildRunTargetRows,
  getEphemeralVmLabel,
  getRecipeDetail,
  RUN_TARGET_ADD_HOST_KEY,
  type EphemeralVmRecipeOption,
  type RunTargetHostOption
} from './run-target-options'
import { AddHostSubmenuRow } from './RunTargetSubmenus'
import RunTargetRowList from './RunTargetRowList'
import RunTargetField from './RunTargetField'
import { HostListOverflowNote } from '@/components/host-picker/HostListOverflowNote'
import type { WslHostDistro } from '../../../../../shared/remote-runtime/wsl-hosts/wsl-host-types'

type RunTargetComboboxProps = {
  hostOptions: readonly RunTargetHostOption[]
  selectedHostId: string | null
  recipes?: readonly EphemeralVmRecipeOption[]
  recipeValue?: string | null
  onRecipeChange?: (recipeId: string | null) => void
  onAddRemoteServer?: () => void
  onAddSshHost?: () => void
  /** A distro picked under Add host › WSL distro. */
  onAddWslDistro?: (distro: WslHostDistro) => void
  onOpenChange?: (open: boolean) => void
  fieldName?: string
  errorId?: string
  emptyMessage?: string
  /** The chosen host's name loses its middle rather than its end when it doesn't fit. */
  truncateMiddle?: boolean
}

const ROOT_ATTRIBUTE = 'data-run-target-combobox-root'
const NO_RECIPES: readonly EphemeralVmRecipeOption[] = []

/** Match project-picker navigation; Connect must not select its host, and recipe/Add host rows open nested lists. */
export default function RunTargetCombobox({
  hostOptions,
  selectedHostId,
  recipes = NO_RECIPES,
  recipeValue = null,
  onRecipeChange,
  onAddRemoteServer,
  onAddSshHost,
  onAddWslDistro,
  onOpenChange,
  fieldName,
  errorId,
  emptyMessage,
  truncateMiddle
}: RunTargetComboboxProps): React.JSX.Element {
  const t = useTranslate()
  const [submenu, setSubmenu] = useState<'recipes' | 'add-host' | 'add-host-keyboard' | null>(null)
  const addHostOpen = submenu === 'add-host' || submenu === 'add-host-keyboard'

  const hasAddHost = Boolean(onAddSshHost || onAddRemoteServer || onAddWslDistro)
  const deriveRowKeys = useCallback(
    (query: string): string[] =>
      buildRunTargetRows({ hostOptions, recipes, query, hasAddHost }).rows.map((row) => row.key),
    [hasAddHost, hostOptions, recipes]
  )
  const combobox = useTypeAheadCombobox(deriveRowKeys)
  const { query, setQuery, open, setOpen, armedKey, arm, moveArm, inputRef, listId, setListNode } =
    combobox

  const { rows, matchedRecipes, hiddenHostCount } = useMemo(
    () => buildRunTargetRows({ hostOptions, recipes, query, hasAddHost }),
    [hasAddHost, hostOptions, query, recipes]
  )
  const selectedHost = hostOptions.find((option) => option.id === selectedHostId) ?? null
  const selectedRecipe = recipes.find((recipe) => recipe.id === recipeValue) ?? null
  const armedRow = rows.find((row) => row.key === armedKey) ?? rows[0] ?? null
  const committed = query.length === 0 && (selectedRecipe !== null || selectedHost !== null)

  // Closing also drops any open submenu, which the shared hook doesn't know about.
  const close = useCallback((): void => {
    combobox.close()
    setSubmenu(null)
    if (open) {
      onOpenChange?.(false)
    }
  }, [combobox, onOpenChange, open])

  const openPicker = useCallback((): void => {
    if (!open) {
      setOpen(true)
      onOpenChange?.(true)
    }
  }, [onOpenChange, open, setOpen])

  const selectHost = useCallback(
    (option: RunTargetHostOption): void => {
      if (!option.onSelect) {
        return
      }
      if (!option.keepOpen) {
        close()
      }
      option.onSelect()
      if (option.available) {
        onRecipeChange?.(null)
      }
    },
    [close, onRecipeChange]
  )

  const selectRecipe = useCallback(
    (recipeId: string): void => {
      onRecipeChange?.(recipeId)
      close()
    },
    [close, onRecipeChange]
  )

  const activate = useCallback(
    (key: string | null): void => {
      const row = rows.find((candidate) => candidate.key === key)
      if (!row) {
        return
      }
      if (row.kind === 'host') {
        selectHost(row.option)
        return
      }
      setSubmenu(row.kind === 'recipes' ? 'recipes' : 'add-host-keyboard')
    },
    [rows, selectHost]
  )

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>): void => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        openPicker()
        moveArm(event.key === 'ArrowDown' ? 1 : -1)
        setSubmenu(null)
        return
      }
      if ((event.key === 'Enter' || event.key === 'ArrowRight') && open) {
        event.preventDefault()
        activate(armedRow?.key ?? null)
        return
      }
      if (event.key === 'Escape' && (open || query.length > 0)) {
        event.preventDefault()
        event.stopPropagation()
        if (submenu !== null) {
          setSubmenu(null)
          return
        }
        close()
      }
    },
    [activate, armedRow, close, moveArm, open, openPicker, query, submenu]
  )

  const handleOpenChange = useCallback(
    (next: boolean): void => {
      if (next) {
        openPicker()
        return
      }
      close()
    },
    [close, openPicker]
  )

  const fieldLabel = selectedRecipe
    ? `${getEphemeralVmLabel(t)} / ${selectedRecipe.name}`
    : (selectedHost?.label ?? '')
  const fieldDetail = selectedRecipe
    ? getRecipeDetail(selectedRecipe, t)
    : (selectedHost?.detail ?? '')

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <RunTargetField
        fieldName={fieldName}
        errorId={errorId}
        query={query}
        onQueryChange={(value) => {
          setQuery(value)
          openPicker()
          setSubmenu(null)
        }}
        open={open}
        onOpenRequest={openPicker}
        onToggle={() => handleOpenChange(!open)}
        committed={committed}
        isRecipe={selectedRecipe !== null}
        hostId={selectedHost?.hostId ?? null}
        icon={selectedRecipe ? undefined : selectedHost?.icon}
        label={fieldLabel}
        detail={fieldDetail}
        listId={listId}
        hasArmedRow={armedRow !== null}
        inputRef={inputRef}
        onKeyDown={handleKeyDown}
        truncateMiddle={truncateMiddle}
      />
      <PopoverContent
        align="start"
        sideOffset={4}
        wheelScroll
        className={cn(
          'flex w-(--radix-popover-trigger-width) min-w-[min(18rem,var(--radix-popover-content-available-width))] max-w-(--radix-popover-content-available-width) flex-col',
          COMBOBOX_POPOVER_SURFACE
        )}
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        // The search anchor is outside Radix content; preserve interactions inside this control.
        onFocusOutside={(event) => {
          if (isWithinComboboxRoot(event.target, ROOT_ATTRIBUTE)) {
            event.preventDefault()
          }
        }}
        onInteractOutside={(event) => {
          if (isWithinComboboxRoot(event.target, ROOT_ATTRIBUTE)) {
            event.preventDefault()
          }
        }}
      >
        <div
          id={listId}
          role="listbox"
          aria-label={t('auto.components.new.workspace.RunTargetCombobox.listLabel', 'Run targets')}
          className="flex min-h-0 flex-col"
        >
          <div
            ref={setListNode}
            role="presentation"
            className="max-h-72 min-h-0 flex-1 overflow-y-auto p-1 scrollbar-sleek"
          >
            {rows.filter((row) => row.kind !== 'add-host').length === 0 ? (
              <p className="flex h-8 items-center justify-center px-2 text-sm text-muted-foreground">
                {emptyMessage ??
                  t(
                    'auto.components.NewWorkspaceComposerCard.noRunTargets',
                    'No run targets are ready for this project.'
                  )}
              </p>
            ) : null}
            <RunTargetRowList
              rows={rows}
              armedKey={armedRow?.key ?? null}
              listId={listId}
              selectedHostId={selectedRecipe === null ? selectedHostId : null}
              selectedRecipeId={selectedRecipe?.id ?? null}
              matchedRecipes={matchedRecipes}
              recipesOpen={submenu === 'recipes'}
              onArm={(key, nextSubmenu) => {
                arm(key)
                if (submenu === 'add-host-keyboard') {
                  inputRef.current?.focus()
                }
                setSubmenu(nextSubmenu)
              }}
              onRecipesOpenChange={(next) => setSubmenu(next ? 'recipes' : null)}
              onSelectHost={selectHost}
              onSelectRecipe={selectRecipe}
            />
          </div>
          <HostListOverflowNote hiddenCount={hiddenHostCount} />
          {hasAddHost ? (
            <AddHostSubmenuRow
              open={addHostOpen}
              focusOnOpen={submenu === 'add-host-keyboard'}
              onReturnFocus={() => inputRef.current?.focus()}
              onOpenChange={(next) => setSubmenu(next ? 'add-host' : null)}
              armed={armedRow?.key === RUN_TARGET_ADD_HOST_KEY}
              optionId={armedRow?.key === RUN_TARGET_ADD_HOST_KEY ? `${listId}-armed` : undefined}
              onArm={() => {
                arm(RUN_TARGET_ADD_HOST_KEY)
                if (!addHostOpen) {
                  setSubmenu('add-host')
                }
              }}
              {...(onAddSshHost
                ? {
                    onAddSshHost: () => {
                      close()
                      onAddSshHost()
                    }
                  }
                : {})}
              {...(onAddRemoteServer
                ? {
                    onAddRemoteServer: () => {
                      close()
                      onAddRemoteServer()
                    }
                  }
                : {})}
              {...(onAddWslDistro
                ? {
                    onAddWslDistro: (distro: WslHostDistro) => {
                      close()
                      onAddWslDistro(distro)
                    }
                  }
                : {})}
            />
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  )
}
