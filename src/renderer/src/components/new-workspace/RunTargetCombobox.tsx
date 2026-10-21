import React, { useCallback, useMemo, useState } from 'react'
import { Popover, PopoverContent } from '@/components/ui/popover'
import { translate } from '@/i18n/i18n'
import {
  getProjectHostSetupSelectionKey,
  type NeedsSetupProjectHostOption,
  type ProjectHostSetupOption,
  type ReadyProjectHostSetupOption
} from '@/lib/project-host-setup-options'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { isWithinComboboxRoot, useTypeAheadCombobox } from './use-type-ahead-combobox'
import {
  buildRunTargetRows,
  getEphemeralVmLabel,
  getRecipeDetail,
  isSelectableRunTargetRow,
  readyHostRowKey,
  RUN_TARGET_ADD_HOST_KEY,
  type EphemeralVmRecipeOption
} from './run-target-options'
import { useRunTargetMachines, type RunTargetMachineProps } from './use-run-target-machines'
import type { MachineRowModel } from './run-target-machine-rows'
import { MachineStateLabel } from '@/components/machines/MachineStateLabel'
import { useNow } from '@/hooks/use-now'
import { formatMachineSummary } from '@/lib/machines/machine-copy'
import { AddHostSubmenuRow } from './RunTargetSubmenus'
import { machineGroupLabel } from './RunTargetMachineRow'
import RunTargetRowList from './RunTargetRowList'
import RunTargetField from './RunTargetField'
import { HostListOverflowNote } from '@/components/host-picker/HostListOverflowNote'

type RunTargetComboboxProps = {
  hostOptions: readonly ProjectHostSetupOption[]
  hostValue: string | null
  hostExecutionHostId?: ExecutionHostId | null
  onHostChange?: (setupId: string) => void
  recipes: EphemeralVmRecipeOption[]
  recipeValue: string | null
  onRecipeChange?: (recipeId: string | null) => void
  onAddRemoteServer?: () => void
  onAddSshHost?: () => void
  onConnectHost?: (option: NeedsSetupProjectHostOption) => Promise<void> | void
  onSetLocation?: (option: NeedsSetupProjectHostOption) => void
  /** Provider groups; absent while machines are off. */
  machines?: RunTargetMachineProps
  onBrowseMachinePlugins?: () => void
}

const ROOT_ATTRIBUTE = 'data-run-target-combobox-root'

/**
 * Run-target picker, built to match the project picker: the field *is* the
 * search, exactly one row is armed and Enter takes it, hovering arms, and the
 * "Add host" row is pinned to the popover edge so it survives every state.
 *
 * Two things the project picker doesn't have: disconnected hosts carry an
 * inline Connect action that must not select the row, and two rows open nested
 * lists (VM recipes, Add host) rather than committing.
 */
export default function RunTargetCombobox({
  hostOptions,
  hostValue,
  hostExecutionHostId,
  onHostChange,
  recipes,
  recipeValue,
  onRecipeChange,
  onAddRemoteServer,
  onAddSshHost,
  onConnectHost,
  onSetLocation,
  machines,
  onBrowseMachinePlugins
}: RunTargetComboboxProps): React.JSX.Element {
  const [submenu, setSubmenu] = useState<'recipes' | 'add-host' | null>(null)
  // Track in-flight connects per host so one stalling connect never blocks the others.
  const [connectingHostIds, setConnectingHostIds] = useState<ReadonlySet<string>>(() => new Set())

  const hasAddHost = Boolean(onAddSshHost || onAddRemoteServer || onBrowseMachinePlugins)
  const machineRows = useRunTargetMachines(machines)
  const {
    groups: machineGroups,
    views: machineViews,
    selectedRowKey: selectedMachineRowKey,
    activate: activateMachine
  } = machineRows
  const selectedMachine = machines?.selected ?? null
  const deriveRowKeys = useCallback(
    (query: string): string[] =>
      buildRunTargetRows({ hostOptions, recipes, machineGroups, machineViews, query, hasAddHost })
        .rows.filter(isSelectableRunTargetRow)
        .map((row) => row.key),
    [hasAddHost, hostOptions, machineGroups, machineViews, recipes]
  )
  const readyHostOptions = useMemo(
    () => hostOptions.filter((option) => option.kind === 'ready'),
    [hostOptions]
  )
  const isSelected = (candidate: { id: string; hostId: string }): boolean =>
    candidate.id === hostValue && (!hostExecutionHostId || candidate.hostId === hostExecutionHostId)
  const selectedHost =
    readyHostOptions.find(isSelected) ??
    // Why: a selection on a merged machine's other id still belongs to that machine's one row.
    readyHostOptions.find((option) => option.aliasSetups?.some(isSelected)) ??
    readyHostOptions[0] ??
    null
  const selectedRecipe = recipes.find((recipe) => recipe.id === recipeValue) ?? null
  // Why: opening arms the current row, so the one filled row is the selection.
  const currentRowKey =
    selectedMachineRowKey ??
    (selectedRecipe === null && selectedHost !== null ? readyHostRowKey(selectedHost) : null)
  const combobox = useTypeAheadCombobox(deriveRowKeys, currentRowKey)
  const {
    query,
    setQuery,
    open,
    setOpen,
    close: closeCombobox,
    armedKey,
    arm,
    moveArm,
    inputRef,
    listId,
    setListNode
  } = combobox
  const now = useNow(60_000, open)

  const { rows, matchedRecipes, hiddenHostCount } = useMemo(
    () =>
      buildRunTargetRows({ hostOptions, recipes, machineGroups, machineViews, query, hasAddHost }),
    [hasAddHost, hostOptions, machineGroups, machineViews, query, recipes]
  )
  const armedRow =
    rows.find((row) => row.key === armedKey) ?? rows.find(isSelectableRunTargetRow) ?? null
  // Only a committed selection paints the field; typing replaces it.
  const committed =
    query.length === 0 &&
    (selectedMachine !== null || selectedRecipe !== null || selectedHost !== null)

  // Closing also drops any open submenu, which the shared hook doesn't know about.
  const close = useCallback((): void => {
    closeCombobox()
    setSubmenu(null)
  }, [closeCombobox])

  const selectHost = useCallback(
    (option: ReadyProjectHostSetupOption): void => {
      onHostChange?.(getProjectHostSetupSelectionKey(option))
      onRecipeChange?.(null)
      machines?.onChange(null)
      close()
    },
    [close, machines, onHostChange, onRecipeChange]
  )

  const selectRecipe = useCallback(
    (recipeId: string): void => {
      onRecipeChange?.(recipeId)
      machines?.onChange(null)
      close()
    },
    [close, machines, onRecipeChange]
  )

  const connectHost = useCallback(
    async (option: NeedsSetupProjectHostOption): Promise<void> => {
      if (!option.connectAction || !onConnectHost || connectingHostIds.has(option.hostId)) {
        return
      }
      setConnectingHostIds((current) => new Set(current).add(option.hostId))
      try {
        await onConnectHost(option)
      } finally {
        // Always clear when the connect settles (success, failure, or timeout)
        // so the row's spinner stops.
        setConnectingHostIds((current) => {
          if (!current.has(option.hostId)) {
            return current
          }
          const next = new Set(current)
          next.delete(option.hostId)
          return next
        })
      }
    },
    [connectingHostIds, onConnectHost]
  )

  // Why: reached from the row body, its inline button, and Enter — keep one path
  // so all three close the picker before handing off to the nested dialog.
  const setLocation = useCallback(
    (option: NeedsSetupProjectHostOption): void => {
      if (!option.canSetLocation || !onSetLocation) {
        return
      }
      close()
      onSetLocation(option)
    },
    [close, onSetLocation]
  )

  const activateMachineRow = useCallback(
    (row: MachineRowModel): void => {
      if (row.kind === 'machine') {
        onRecipeChange?.(null)
      }
      // Why: a paired server's machine runs worktrees at the project's location on it.
      if (row.kind === 'machine' && row.machine.locationKey) {
        onHostChange?.(row.machine.locationKey)
      }
      activateMachine(row, close)
    },
    [activateMachine, close, onHostChange, onRecipeChange]
  )

  /** Commits a row, or opens its submenu when the row is a submenu row. */
  const activate = useCallback(
    (key: string | null): void => {
      const row = rows.find((candidate) => candidate.key === key)
      if (!row || !isSelectableRunTargetRow(row)) {
        return
      }
      if (row.kind === 'ready') {
        selectHost(row.option)
        return
      }
      if (row.kind === 'needs-setup') {
        // Not ready: setting the location is the only way forward from the row itself.
        setLocation(row.option)
        return
      }
      if (row.kind === 'recipes' || row.kind === 'add-host') {
        setSubmenu(row.kind)
        return
      }
      activateMachineRow(row)
    },
    [activateMachineRow, rows, selectHost, setLocation]
  )

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>): void => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        setOpen(true)
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
        // A submenu closes first, so Escape backs out one layer at a time.
        if (submenu !== null) {
          setSubmenu(null)
          return
        }
        close()
      }
    },
    [activate, armedRow, close, moveArm, open, query, setOpen, submenu]
  )

  const handleOpenChange = useCallback(
    (next: boolean): void => {
      if (next) {
        setOpen(true)
        return
      }
      close()
    },
    [close, setOpen]
  )

  const fieldLabel = selectedMachine
    ? selectedMachine.machine.name
    : selectedRecipe
      ? `${getEphemeralVmLabel()} / ${selectedRecipe.name}`
      : (selectedHost?.label ?? '')
  const fieldDetail = selectedMachine
    ? formatMachineSummary(machineGroupLabel(selectedMachine.group), selectedMachine.machine)
    : selectedRecipe
      ? getRecipeDetail(selectedRecipe)
      : (selectedHost?.path ?? '')

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <RunTargetField
        query={query}
        onQueryChange={(value) => {
          setQuery(value)
          setOpen(true)
          setSubmenu(null)
        }}
        open={open}
        onOpenRequest={() => setOpen(true)}
        onToggle={() => setOpen(!open)}
        committed={committed}
        kind={selectedMachine ? 'machine' : selectedRecipe ? 'recipe' : 'host'}
        // Why: Running is the expected state, so only another state earns the dot and word.
        status={
          selectedMachine && selectedMachine.machine.state !== 'running' ? (
            <MachineStateLabel state={selectedMachine.machine.state} />
          ) : null
        }
        hostId={selectedHost?.hostId ?? null}
        label={fieldLabel}
        detail={fieldDetail}
        listId={listId}
        hasArmedRow={armedRow !== null}
        inputRef={inputRef}
        onKeyDown={handleKeyDown}
      />
      <PopoverContent
        align="start"
        sideOffset={4}
        surface="opaque"
        className="flex w-[var(--radix-popover-trigger-width)] min-w-[18rem] flex-col"
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        // The field lives in the anchor, not the content, so Radix would see a
        // focus/pointer event "outside" and dismiss the instant you tab in.
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
          aria-label={translate(
            'auto.components.new.workspace.RunTargetCombobox.listLabel',
            'Run targets'
          )}
          className="flex min-h-0 flex-col"
        >
          <div
            ref={setListNode}
            role="presentation"
            className="max-h-72 min-h-0 flex-1 overflow-y-auto p-1 scrollbar-sleek"
          >
            {rows.filter((row) => row.kind !== 'add-host').length === 0 ? (
              <p className="flex h-8 items-center justify-center px-2 text-sm text-muted-foreground">
                {translate(
                  'auto.components.NewWorkspaceComposerCard.noRunTargets',
                  'No run targets are ready for this project.'
                )}
              </p>
            ) : null}
            <RunTargetRowList
              rows={rows}
              armedKey={armedRow?.key ?? null}
              listId={listId}
              selectedHost={
                selectedRecipe === null && selectedMachine === null ? selectedHost : null
              }
              selectedRecipeId={selectedRecipe?.id ?? null}
              matchedRecipes={matchedRecipes}
              recipesOpen={submenu === 'recipes'}
              connectingHostIds={connectingHostIds}
              canConnect={Boolean(onConnectHost)}
              canSetLocation={Boolean(onSetLocation)}
              onArm={(key, nextSubmenu) => {
                arm(key)
                setSubmenu(nextSubmenu)
              }}
              onRecipesOpenChange={(next) => setSubmenu(next ? 'recipes' : null)}
              onSelectHost={selectHost}
              onSelectRecipe={selectRecipe}
              onConnectHost={(option) => void connectHost(option)}
              onSetLocation={setLocation}
              selectedMachineRowKey={selectedMachineRowKey}
              now={now}
              onActivateMachineRow={activateMachineRow}
            />
          </div>
          {/* Why outside the listbox: the note is not an option. */}
          <HostListOverflowNote hiddenCount={hiddenHostCount} />
          {hasAddHost ? (
            <AddHostSubmenuRow
              open={submenu === 'add-host'}
              onOpenChange={(next) => setSubmenu(next ? 'add-host' : null)}
              armed={armedRow?.key === RUN_TARGET_ADD_HOST_KEY}
              optionId={armedRow?.key === RUN_TARGET_ADD_HOST_KEY ? `${listId}-armed` : undefined}
              onArm={() => {
                arm(RUN_TARGET_ADD_HOST_KEY)
                setSubmenu('add-host')
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
              {...(onBrowseMachinePlugins
                ? {
                    onBrowseMachinePlugins: () => {
                      close()
                      onBrowseMachinePlugins()
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
