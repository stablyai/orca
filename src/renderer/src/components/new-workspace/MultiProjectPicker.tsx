import React, { useId, useMemo, useState } from 'react'
import { Check, FolderPlus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { RepoBadgeMark } from '@/components/repo/RepoBadgeLabel'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { ProjectHostSetup } from '../../../../shared/project-types'
import type { NewWorkspaceProjectOption } from '@/lib/new-workspace-project-options'
import { getMultiRepoUnavailableCopy } from './multi-repo-composer-copy'
import {
  buildMultiProjectPickerRows,
  type MultiProjectPickerRow
} from './multi-project-picker-rows'

type MultiProjectPickerProps = {
  options: readonly NewWorkspaceProjectOption[]
  setups: readonly ProjectHostSetup[]
  hostId: ExecutionHostId
  hostLabel: string
  selectedProjectIds: readonly string[]
  onToggleProject: (projectId: string) => void
  /** Switches the workspace host; only offered when a project has exactly one alternative host. */
  onUseHost: (hostId: ExecutionHostId) => void
  /** False when the primary project has no ready setup there, so the action would do nothing. */
  canUseHost: (hostId: ExecutionHostId) => boolean
  getHostLabel: (hostId: ExecutionHostId) => string
  onAddProject: () => void
  triggerRef?: React.Ref<HTMLButtonElement>
  disabled?: boolean
}

function matchesQuery(row: MultiProjectPickerRow, query: string): boolean {
  const needle = query.trim().toLowerCase()
  return (
    needle === '' ||
    row.option.displayName.toLowerCase().includes(needle) ||
    row.option.detail.toLowerCase().includes(needle)
  )
}

export default function MultiProjectPicker({
  options,
  setups,
  hostId,
  hostLabel,
  selectedProjectIds,
  onToggleProject,
  onUseHost,
  canUseHost,
  getHostLabel,
  onAddProject,
  triggerRef,
  disabled = false
}: MultiProjectPickerProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const reasonIdPrefix = useId()
  const rows = useMemo(
    () => buildMultiProjectPickerRows(options, setups, hostId, selectedProjectIds),
    [options, setups, hostId, selectedProjectIds]
  )
  const available = rows.available.filter((row) => matchesQuery(row, query))
  const unavailable = rows.unavailable.filter((row) => matchesQuery(row, query))
  const hasProjects = rows.available.length + rows.unavailable.length > 0

  const renderRow = (row: MultiProjectPickerRow): React.JSX.Element => {
    const { option, selected, unavailable: reason } = row
    const blocked = reason !== null && !selected
    const reasonId = `${reasonIdPrefix}-${option.projectId}`
    return (
      // cmdk skips `disabled` items; keep blocked rows focusable so the reason is announced.
      <CommandItem
        key={option.projectId}
        value={option.projectId}
        aria-disabled={blocked || undefined}
        aria-describedby={reason ? reasonId : undefined}
        onSelect={() => {
          if (!blocked) {
            onToggleProject(option.projectId)
          }
        }}
      >
        <div
          className={cn(
            'flex min-w-0 flex-1 items-start gap-2',
            blocked && 'opacity-60 motion-safe:transition-opacity motion-safe:duration-150'
          )}
        >
          <Check
            className={cn(
              'mt-0.5 size-3 text-muted-foreground',
              selected ? 'opacity-70' : 'opacity-0'
            )}
          />
          <div className="min-w-0 flex-1">
            <span className="inline-flex max-w-full items-center gap-1.5">
              <RepoBadgeMark color={option.badgeColor} />
              <span className="truncate">{option.displayName}</span>
            </span>
            <p className="mt-0.5 truncate text-[10px] text-muted-foreground" title={option.detail}>
              {option.detail}
            </p>
            {reason ? (
              <p
                id={reasonId}
                className="mt-0.5 whitespace-normal text-[10px] text-muted-foreground"
              >
                {getMultiRepoUnavailableCopy(reason, hostLabel)}
                {row.alternativeHostId && canUseHost(row.alternativeHostId) ? (
                  <button
                    type="button"
                    className="ml-1.5 underline underline-offset-2 hover:text-foreground"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={(event) => {
                      event.stopPropagation()
                      if (row.alternativeHostId) {
                        onUseHost(row.alternativeHostId)
                      }
                    }}
                  >
                    {translate('auto.components.newWorkspace.multiRepo.useHost', 'Use {{host}}', {
                      host: getHostLabel(row.alternativeHostId)
                    })}
                  </button>
                ) : null}
              </p>
            ) : null}
          </div>
        </div>
      </CommandItem>
    )
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) {
          setQuery('')
        }
      }}
    >
      <PopoverTrigger asChild>
        <Button
          ref={triggerRef}
          type="button"
          variant="outline"
          size="xs"
          disabled={disabled}
          aria-haspopup="listbox"
          aria-expanded={open}
        >
          <FolderPlus className="size-3" />
          {translate('auto.components.NewWorkspaceComposerCard.d6b0a96f32', 'Add project')}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[min(340px,calc(100vw-1rem))]"
        // Esc closes the popover only; the composer must stay open and focus returns to the trigger.
        onEscapeKeyDown={(event) => event.stopPropagation()}
      >
        <Command shouldFilter={false} density="menu">
          <CommandInput
            autoFocus
            value={query}
            onValueChange={setQuery}
            placeholder={translate(
              'auto.components.ui.repo.multi.combobox.a58a0cd100',
              'Search projects...'
            )}
          />
          <CommandList aria-multiselectable="true">
            {!hasProjects ? (
              <div className="space-y-2 px-3 py-3 text-xs text-muted-foreground">
                <p>
                  {translate(
                    'auto.components.newWorkspace.multiRepo.addAnotherGitProject',
                    'Add another git project to create a workspace across repos.'
                  )}
                </p>
                <Button type="button" variant="link" size="xs" onClick={onAddProject}>
                  {translate('auto.components.NewWorkspaceComposerCard.d6b0a96f32', 'Add project')}
                </Button>
              </div>
            ) : available.length + unavailable.length === 0 ? (
              <CommandEmpty>
                {translate(
                  'auto.components.ui.repo.multi.combobox.4471d4a1c0',
                  'No projects match your search.'
                )}
              </CommandEmpty>
            ) : (
              <>
                {available.map(renderRow)}
                {unavailable.length > 0 ? (
                  <>
                    <div
                      role="separator"
                      className="border-t border-border px-3 pb-0.5 pt-1.5 text-[10px] font-medium text-muted-foreground"
                    >
                      {translate(
                        'auto.components.newWorkspace.multiRepo.unavailableOnHost',
                        'Unavailable on this host'
                      )}
                    </div>
                    {unavailable.map(renderRow)}
                  </>
                ) : null}
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
