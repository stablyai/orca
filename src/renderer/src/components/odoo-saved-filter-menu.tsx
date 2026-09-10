import React, { useState } from 'react'
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors
} from '@dnd-kit/core'
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy
} from '@dnd-kit/sortable'
import { Bookmark, Check } from 'lucide-react'

import { OdooSavedFilterRow } from '@/components/odoo-saved-filter-row'
import {
  isSavedOdooTicketFilterActive,
  type OdooSavedTicketFilter
} from '@/components/odoo-saved-ticket-filters'
import type { OdooTicketListFilters } from '@/components/odoo-ticket-facets'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { OdooTicketFilter } from '../../../shared/odoo-types'
/** Recall, save and delete named preset+facet combinations for the ticket list. */
export function OdooSavedFilterMenu({
  saved,
  presets,
  preset,
  presetActive,
  onPresetSelect,
  filters,
  onApply,
  onSave,
  onDelete,
  onSetDefault,
  onTogglePinned,
  onReorder
}: {
  saved: OdooSavedTicketFilter[]
  presets: { id: OdooTicketFilter; label: string }[]
  preset: OdooTicketFilter
  presetActive: boolean
  onPresetSelect: (preset: OdooTicketFilter) => void
  filters: OdooTicketListFilters
  onApply: (entry: OdooSavedTicketFilter) => void
  onSave: (name: string) => void
  onDelete: (id: string) => void
  onSetDefault: (id: string) => void
  onTogglePinned: (id: string) => void
  onReorder: (activeId: string, overId: string) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  // A small distance threshold keeps the handle clickable without starting a
  // drag on every stray pointer-down inside the popover.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  const activeEntry = saved.find((entry) => isSavedOdooTicketFilterActive(entry, preset, filters))
  const activePreset = presets.find((entry) => entry.id === preset)

  const submit = (): void => {
    const trimmed = name.trim()
    if (!trimmed) {
      return
    }
    onSave(trimmed)
    setName('')
    setOpen(false)
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) {
          setName('')
        }
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="h-7 max-w-44 justify-start gap-1.5 px-2 text-xs font-normal"
          title={translate('auto.components.odoo.saved.filter.menu.88c6da15ed', 'Saved filters')}
        >
          <Bookmark
            className={cn('size-3.5 shrink-0', activeEntry ? 'fill-current' : 'opacity-50')}
          />
          <span className="truncate">
            {activeEntry?.name ??
              (presetActive && activePreset
                ? activePreset.label
                : translate('auto.components.odoo.saved.filter.menu.88c6da15ed', 'Saved filters'))}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-0">
        <div className="max-h-64 overflow-y-auto scrollbar-sleek py-1">
          <p className="px-3 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
            {translate('auto.components.odoo.saved.filter.menu.c089bd7f5d', 'Presets')}
          </p>
          {presets.map((entry) => (
            <button
              key={entry.id}
              type="button"
              onClick={() => {
                onPresetSelect(entry.id)
                setOpen(false)
              }}
              className="flex w-full items-center gap-2 rounded px-3 py-1.5 text-left text-xs hover:bg-accent/60"
            >
              <Check
                className={cn(
                  'size-3 shrink-0 text-muted-foreground',
                  presetActive && entry.id === preset ? 'opacity-70' : 'opacity-0'
                )}
              />
              <span className="min-w-0 truncate">{entry.label}</span>
            </button>
          ))}
          <p className="mt-1 border-t border-border/60 px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
            {translate('auto.components.odoo.saved.filter.menu.4008391fe0', 'Saved')}
          </p>
          {saved.length === 0 ? (
            <p className="px-3 py-2 text-xs text-muted-foreground">
              {translate(
                'auto.components.odoo.saved.filter.menu.a9ec70f877',
                'No saved filter yet. Set up the toolbar, save it below, then pin it to keep it in reach.'
              )}
            </p>
          ) : (
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={({ active, over }) => {
                if (over && active.id !== over.id) {
                  onReorder(String(active.id), String(over.id))
                }
              }}
            >
              <SortableContext
                items={saved.map((entry) => entry.id)}
                strategy={verticalListSortingStrategy}
              >
                {saved.map((entry) => (
                  <OdooSavedFilterRow
                    key={entry.id}
                    entry={entry}
                    active={entry.id === activeEntry?.id}
                    onApply={(applied) => {
                      onApply(applied)
                      setOpen(false)
                    }}
                    onTogglePinned={onTogglePinned}
                    onSetDefault={onSetDefault}
                    onDelete={onDelete}
                  />
                ))}
              </SortableContext>
            </DndContext>
          )}
        </div>
        <form
          className="flex items-center gap-1 border-t border-border/60 p-2"
          onSubmit={(event) => {
            event.preventDefault()
            submit()
          }}
        >
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={translate(
              'auto.components.odoo.saved.filter.menu.5f484b298e',
              'Name these filters…'
            )}
            className="h-7 flex-1 text-xs"
          />
          <Button type="submit" size="sm" className="h-7 px-2 text-xs" disabled={!name.trim()}>
            {translate('auto.components.odoo.saved.filter.menu.ac57de0469', 'Save')}
          </Button>
        </form>
      </PopoverContent>
    </Popover>
  )
}
