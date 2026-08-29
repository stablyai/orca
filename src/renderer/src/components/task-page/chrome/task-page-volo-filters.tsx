import React from 'react'
import { LoaderCircle, Plus, RefreshCw, Search } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type { VoloBoard, VoloTaskFilter } from '../../../../../shared/volo-types'
import type { VoloPreset } from '@/components/task-page-localized-options'

export type TaskPageVoloFiltersProps = {
  voloPresets: VoloPreset[]
  voloSearchInput: string
  activeVoloPreset: VoloTaskFilter
  setVoloSearchInput: (value: string) => void
  setActiveVoloPreset: (preset: VoloTaskFilter) => void
  setVoloRefreshNonce: React.Dispatch<React.SetStateAction<number>>
  voloBoards: readonly VoloBoard[]
  selectedVoloBoardId: string | null
  setSelectedVoloBoardId: (boardId: string) => void
  setNewVoloTaskOpen: (open: boolean) => void
  voloBoardsLoading: boolean
  voloLoading: boolean
}

export function TaskPageVoloFilters({
  voloPresets,
  voloSearchInput,
  activeVoloPreset,
  setVoloSearchInput,
  setActiveVoloPreset,
  setVoloRefreshNonce,
  voloBoards,
  selectedVoloBoardId,
  setSelectedVoloBoardId,
  setNewVoloTaskOpen,
  voloBoardsLoading,
  voloLoading
}: TaskPageVoloFiltersProps): React.JSX.Element {
  return (
    <div className="rounded-md rounded-b-none border border-border/50 bg-muted/50 px-3 pt-2 pb-0 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          {voloBoards.length > 0 ? (
            <Select
              value={selectedVoloBoardId ?? undefined}
              onValueChange={(value) => setSelectedVoloBoardId(value)}
            >
              <SelectTrigger className="h-8 w-[220px] rounded-md border-border/50 bg-muted/50 text-xs font-medium shadow-sm">
                <SelectValue
                  placeholder={translate(
                    'auto.components.TaskPage.voloSelectBoard',
                    'Select a board'
                  )}
                />
              </SelectTrigger>
              <SelectContent>
                {voloBoards.map((board) => (
                  <SelectItem key={board.id} value={board.id}>
                    {board.icon ? `${board.icon} ${board.name}` : board.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
          {voloPresets.map((preset) => {
            const active = !voloSearchInput && activeVoloPreset === preset.id
            return (
              <button
                key={preset.id}
                type="button"
                onClick={() => {
                  setVoloSearchInput('')
                  setActiveVoloPreset(preset.id)
                  setVoloRefreshNonce((n) => n + 1)
                }}
                className={cn(
                  'rounded-md border px-2 py-1 text-xs transition',
                  active
                    ? 'border-border/50 bg-foreground/90 text-background backdrop-blur-md'
                    : 'border-border/50 bg-transparent text-foreground hover:bg-muted/50'
                )}
              >
                {preset.label}
              </button>
            )
          })}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="icon"
                onClick={() => setNewVoloTaskOpen(true)}
                disabled={!selectedVoloBoardId || voloBoardsLoading}
                aria-label={translate('auto.components.TaskPage.voloNewTask', 'New Volo task')}
                className="border-border/50 bg-transparent hover:bg-muted/50"
              >
                {voloBoardsLoading ? (
                  <LoaderCircle className="size-4 animate-spin" />
                ) : (
                  <Plus className="size-4" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              {translate('auto.components.TaskPage.voloNewTask', 'New Volo task')}
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="icon"
                onClick={() => setVoloRefreshNonce((n) => n + 1)}
                disabled={voloLoading}
                aria-label={translate('auto.components.TaskPage.voloRefresh', 'Refresh Volo tasks')}
                className="border-border/50 bg-transparent hover:bg-muted/50"
              >
                {voloLoading ? (
                  <LoaderCircle className="size-4 animate-spin" />
                ) : (
                  <RefreshCw className="size-4" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              {translate('auto.components.TaskPage.voloRefresh', 'Refresh Volo tasks')}
            </TooltipContent>
          </Tooltip>
        </div>
      </div>
      <div className="mt-3 flex items-center gap-3">
        <div className="relative min-w-[320px] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={voloSearchInput}
            onChange={(event) => setVoloSearchInput(event.target.value)}
            placeholder={translate(
              'auto.components.TaskPage.voloSearchPlaceholder',
              'Search Volo tasks'
            )}
            className="h-8 border-border/50 bg-background/70 pl-8 text-sm"
          />
        </div>
      </div>
    </div>
  )
}
