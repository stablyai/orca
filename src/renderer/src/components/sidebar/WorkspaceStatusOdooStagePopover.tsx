import React, { useEffect, useState } from 'react'
import { Check, LoaderCircle } from 'lucide-react'

import { OdooIcon } from '@/components/icons/OdooIcon'
import { Button } from '@/components/ui/button'
import { Command, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store'
import { odooListStageNames } from '@/runtime/runtime-odoo-client'
import { translate } from '@/i18n/i18n'
import type { WorkspaceStatusDefinition } from '../../../../shared/worktree/types'
/**
 * Picks the Odoo stage a board column maps to, from the stage names that
 * actually exist in the instance. Typing a name by hand was too easy to get
 * wrong — a typo silently produced a column that never synced.
 */
export default function WorkspaceStatusOdooStagePopover({
  status,
  onChange
}: {
  status: WorkspaceStatusDefinition
  onChange: (statusId: string, stageName: string) => void
}): React.JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const odooConnected = useAppStore((s) => s.odooStatus.connected)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [names, setNames] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const [retryToken, setRetryToken] = useState(0)

  // Fetched on open rather than on mount: the settings menu renders one of
  // these per column, and none of them is worth a read until it is used.
  useEffect(() => {
    if (!open) {
      return
    }
    let cancelled = false
    setLoading(true)
    setFailed(false)
    void odooListStageNames(useAppStore.getState().settings, null)
      .then((rows) => {
        if (!cancelled) {
          setNames(rows)
        }
      })
      // A failed read must not look like "this instance has no stages": without
      // a distinct state the list would silently render as empty.
      .catch(() => {
        if (!cancelled) {
          setFailed(true)
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [open, settings, retryToken])

  const mapped = status.odooStageName?.trim() ?? ''
  const lowered = query.trim().toLowerCase()
  const visible = lowered ? names.filter((name) => name.toLowerCase().includes(lowered)) : names
  // A previously mapped stage may not exist any more (renamed, module removed);
  // keeping it listed lets the user see and clear it. It still has to match the
  // query — cmdk runs with shouldFilter={false}, so nothing else would drop it.
  const mappedMatches = !lowered || mapped.toLowerCase().includes(lowered)
  const options =
    mapped && !names.includes(mapped) && mappedMatches ? [mapped, ...visible] : visible

  return (
    <Popover
      modal={false}
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
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-expanded={open}
          className={cn('size-7', mapped ? 'text-foreground' : 'text-muted-foreground/60')}
          title={
            mapped
              ? translate(
                  'auto.components.sidebar.WorkspaceStatusOdooStagePopover.3f922ca608',
                  'Odoo stage: {{value0}}',
                  { value0: mapped }
                )
              : translate(
                  'auto.components.sidebar.WorkspaceStatusOdooStagePopover.fa5cb01247',
                  'Link an Odoo stage'
                )
          }
          aria-label={translate(
            'auto.components.sidebar.WorkspaceStatusOdooStagePopover.fa5cb01247',
            'Link an Odoo stage'
          )}
        >
          <OdooIcon className="size-3.5" />
        </Button>
      </PopoverTrigger>
      {/* Same stacking and placement as the appearance popover: without the
          explicit z-index it renders under the settings DropdownMenuContent. */}
      <PopoverContent
        align="end"
        side="left"
        sideOffset={8}
        className="z-[80] w-60 p-0"
        data-workspace-status-appearance-popover=""
      >
        {!odooConnected ? (
          <p className="px-3 py-3 text-[11px] text-muted-foreground">
            {translate(
              'auto.components.sidebar.WorkspaceStatusOdooStagePopover.433bed4d29',
              'Connect Odoo to pick a stage.'
            )}
          </p>
        ) : (
          <Command shouldFilter={false}>
            <CommandInput
              autoFocus
              value={query}
              onValueChange={setQuery}
              placeholder={translate(
                'auto.components.sidebar.WorkspaceStatusOdooStagePopover.60dd4d219d',
                'Search stages…'
              )}
              className="text-xs"
            />
            <CommandList>
              {/* Rendered by hand rather than through CommandEmpty: the list
                  always carries the "no stage" item, so cmdk never sees an
                  empty result set. */}
              {loading && names.length === 0 ? (
                <div className="flex items-center justify-center py-4">
                  <LoaderCircle className="size-4 animate-spin text-muted-foreground" />
                </div>
              ) : failed ? (
                <div className="flex flex-col items-center gap-1 py-3 text-[11px] text-muted-foreground">
                  <span>
                    {translate(
                      'auto.components.sidebar.WorkspaceStatusOdooStagePopover.2c61457ed8',
                      'Could not load stages.'
                    )}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    onClick={() => setRetryToken((token) => token + 1)}
                  >
                    {translate(
                      'auto.components.sidebar.WorkspaceStatusOdooStagePopover.49dcc01885',
                      'Retry'
                    )}
                  </Button>
                </div>
              ) : options.length === 0 ? (
                <div className="py-4 text-center text-[11px] text-muted-foreground">
                  {translate(
                    'auto.components.sidebar.WorkspaceStatusOdooStagePopover.db8a7f7ae0',
                    'No stage matches.'
                  )}
                </div>
              ) : null}
              <CommandItem
                value="__none__"
                onSelect={() => {
                  onChange(status.id, '')
                  setOpen(false)
                }}
                className="items-center gap-2 px-2 py-1.5 text-xs"
              >
                <Check
                  className={cn(
                    'size-3 text-muted-foreground',
                    mapped ? 'opacity-0' : 'opacity-70'
                  )}
                />
                <span className="text-muted-foreground">
                  {translate(
                    'auto.components.sidebar.WorkspaceStatusOdooStagePopover.1282a439d8',
                    'No stage (do not sync)'
                  )}
                </span>
              </CommandItem>
              {options.map((name) => (
                <CommandItem
                  key={name}
                  value={name}
                  onSelect={() => {
                    onChange(status.id, name)
                    setOpen(false)
                  }}
                  className="items-center gap-2 px-2 py-1.5 text-xs"
                >
                  <Check
                    className={cn(
                      'size-3 text-muted-foreground',
                      mapped === name ? 'opacity-70' : 'opacity-0'
                    )}
                  />
                  <span className="min-w-0 truncate">{name}</span>
                </CommandItem>
              ))}
            </CommandList>
          </Command>
        )}
      </PopoverContent>
    </Popover>
  )
}
