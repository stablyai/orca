import React, { useCallback, useEffect, useState } from 'react'
import { Check, ChevronsUpDown, LoaderCircle } from 'lucide-react'

import { buildAssigneeStack } from '@/components/odoo-ticket-assignee-stack'
import { ODOO_TICKET_CONTROL_WIDTH_CLASS } from '@/components/odoo-ticket-control-width'
import { OdooUserAvatar } from '@/components/odoo-user-avatar'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store'
import { odooListAssignableUsers } from '@/runtime/runtime-odoo-client'
import { translate } from '@/i18n/i18n'
import type { OdooTicket, OdooUser } from '../../../shared/odoo-types'
const SEARCH_DEBOUNCE_MS = 250

function renderTriggerLabel(assignees: OdooUser[]): React.JSX.Element {
  if (assignees.length === 0) {
    return (
      <span className="truncate text-muted-foreground">
        {translate('auto.components.odoo.ticket.assignee.picker.70dacd306b', 'Unassigned')}
      </span>
    )
  }
  const stack = buildAssigneeStack(assignees)
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      {/* Overlapping stack: a multi-assignee ticket stays readable without opening the popover. */}
      <span className="flex shrink-0 items-center -space-x-1.5">
        {stack.visible.map((user) => (
          <OdooUserAvatar key={user.id} user={user} className="size-5 ring-1 ring-background" />
        ))}
      </span>
      {stack.soleName ? <span className="truncate">{stack.soleName}</span> : null}
      {stack.overflowCount > 0 ? (
        <span className="shrink-0 text-muted-foreground">+{stack.overflowCount}</span>
      ) : null}
    </span>
  )
}

/**
 * Multi-select over `project.task.user_ids`. Writes go through the ticket's
 * own update path, so the list row and the panel stay in sync.
 */
export function OdooTicketAssigneePicker({
  ticket,
  saving,
  onChange
}: {
  ticket: OdooTicket
  saving: boolean
  onChange: (assignees: OdooUser[]) => void
}): React.JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [users, setUsers] = useState<OdooUser[]>([])
  const [loading, setLoading] = useState(false)

  const instanceId = ticket.instanceId ?? null

  // Odoo caps the picker at 50 users server-side, so the query has to reach the
  // server rather than filter a locally held list.
  useEffect(() => {
    if (!open) {
      return
    }
    let cancelled = false
    setLoading(true)
    const timer = setTimeout(() => {
      void odooListAssignableUsers(settings, query.trim() || undefined, instanceId)
        .then((rows) => {
          if (!cancelled) {
            setUsers(rows)
          }
        })
        .catch(() => undefined)
        .finally(() => {
          if (!cancelled) {
            setLoading(false)
          }
        })
    }, SEARCH_DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [open, query, instanceId, settings])

  const toggle = useCallback(
    (user: OdooUser) => {
      const selected = ticket.assignees.some((entry) => entry.id === user.id)
      onChange(
        selected
          ? ticket.assignees.filter((entry) => entry.id !== user.id)
          : [...ticket.assignees, user]
      )
    },
    [onChange, ticket.assignees]
  )

  // Selected users can fall outside the current search page; prepending them
  // keeps their checkmarks reachable so a click can still remove them.
  const options = [
    ...ticket.assignees,
    ...users.filter((user) => !ticket.assignees.some((entry) => entry.id === user.id))
  ]

  // The trigger only shows a capped avatar stack, so the full roster lives here.
  const assigneeNames =
    ticket.assignees.map((user) => user.displayName).join(', ') ||
    translate('auto.components.odoo.ticket.assignee.picker.70dacd306b', 'Unassigned')

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
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={saving}
          title={assigneeNames}
          aria-label={assigneeNames}
          className={cn(
            'h-7 justify-between px-2 text-xs font-normal',
            ODOO_TICKET_CONTROL_WIDTH_CLASS
          )}
        >
          {renderTriggerLabel(ticket.assignees)}
          <ChevronsUpDown className="size-3.5 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-0">
        <Command shouldFilter={false}>
          <CommandInput
            autoFocus
            placeholder={translate(
              'auto.components.odoo.ticket.assignee.picker.f803a70f1b',
              'Search users…'
            )}
            value={query}
            onValueChange={setQuery}
            className="text-xs"
          />
          <CommandList>
            {loading && options.length === 0 ? (
              <div className="flex items-center justify-center py-4">
                <LoaderCircle className="size-4 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <CommandEmpty>
                {translate(
                  'auto.components.odoo.ticket.assignee.picker.46182cac96',
                  'No user matches your search.'
                )}
              </CommandEmpty>
            )}
            {options.map((user) => {
              const selected = ticket.assignees.some((entry) => entry.id === user.id)
              return (
                <CommandItem
                  key={user.id}
                  value={String(user.id)}
                  onSelect={() => toggle(user)}
                  className="items-center gap-2 px-2 py-1.5 text-xs"
                >
                  <Check
                    className={cn(
                      'size-3 text-muted-foreground',
                      selected ? 'opacity-70' : 'opacity-0'
                    )}
                  />
                  <OdooUserAvatar user={user} className="size-5" />
                  <span className="min-w-0 truncate">{user.displayName}</span>
                </CommandItem>
              )
            })}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
