import React from 'react'
import { translate } from '@/i18n/i18n'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import type {
  NeedsSetupProjectHostOption,
  ReadyProjectHostSetupOption
} from '@/lib/project-host-setup-options'
import { HostRowIcon, RunTargetGroupHeader, RunTargetRow } from './RunTargetComboboxRow'
import { ConnectHostButton, NeedsSetupHostIcon, SetLocationButton } from './RunTargetRowActions'
import { RecipesSubmenuRow } from './RunTargetSubmenus'
import {
  sectionRunTargetRows,
  type EphemeralVmRecipeOption,
  type RunTargetRowModel,
  type RunTargetRowSection,
  type SelectableRunTargetRow
} from './run-target-options'
import type { MachineRowModel } from './run-target-machine-rows'
import { RunTargetMachineGroupHeader, RunTargetMachineRow } from './RunTargetMachineRow'

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
  onSetLocation,
  selectedMachineRowKey,
  now,
  onActivateMachineRow
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
  /** Row key of the committed machine, if a machine holds the selection. */
  selectedMachineRowKey: string | null
  /** Clock for relative copy such as "seen 4m ago". */
  now: number
  onActivateMachineRow: (row: MachineRowModel) => void
}): React.JSX.Element {
  const renderRow = (row: SelectableRunTargetRow): React.ReactNode => {
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
    if (row.kind === 'recipes') {
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
    }
    return (
      <RunTargetMachineRow
        key={row.key}
        row={row}
        armed={isArmed}
        current={row.key === selectedMachineRowKey}
        optionId={optionId}
        onArm={() => onArm(row.key, null)}
        onCommit={() => onActivateMachineRow(row)}
      />
    )
  }

  const renderHeader = (section: RunTargetRowSection, id: string): React.ReactNode => {
    const { header } = section
    if (header?.kind === 'machine-group') {
      return <RunTargetMachineGroupHeader id={id} group={header.group} now={now} />
    }
    const allSsh = section.rows.every(
      (row) => row.kind === 'needs-setup' && parseExecutionHostId(row.option.hostId)?.kind === 'ssh'
    )
    return (
      <RunTargetGroupHeader
        id={id}
        label={
          allSsh
            ? translate('auto.components.new.workspace.RunTargetRowList.sshHosts', 'SSH hosts')
            : translate('auto.components.new.workspace.RunTargetRowList.otherHosts', 'Other hosts')
        }
      />
    )
  }

  // Why: a rule separates every section, so a provider's last machine never runs into a host.
  return (
    <>
      {sectionRunTargetRows(rows.filter((row) => row.kind !== 'add-host')).map((section, index) => {
        const headerId = `${listId}-group-${index}`
        return (
          <div
            key={section.key}
            role={section.header ? 'group' : 'presentation'}
            aria-labelledby={section.header ? headerId : undefined}
            data-divided={index > 0}
            className="data-[divided=true]:-mx-1 data-[divided=true]:mt-1 data-[divided=true]:border-t data-[divided=true]:border-border data-[divided=true]:px-1"
          >
            {section.header ? renderHeader(section, headerId) : null}
            {section.rows.map(renderRow)}
          </div>
        )
      })}
    </>
  )
}
