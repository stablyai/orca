import React from 'react'
import { LoaderCircle } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import {
  getLinearStateMarkerStyle,
  getLinearStatePillStyle
} from '@/components/linear-state-pill-style'
import { LinearPriorityIcon } from '@/components/linear-priority-icon'
import { translate } from '@/i18n/i18n'
import {
  LINEAR_EDIT_CHIP_CLASS,
  LINEAR_EDIT_MENU_ITEM_CLASS,
  LINEAR_EDIT_MENU_ITEM_WITH_ICON_CLASS,
  LINEAR_ESTIMATE_PRESETS,
  LinearEditChipAdornment,
  PRIORITY_LABELS,
  formatLinearEstimateLabel
} from '@/components/linear-item-drawer-edit-controls'
import type { LinearIssueEditController } from '@/components/linear-item-drawer-edit-controller'

export function renderLinearIssueChipsLayout(
  controller: LinearIssueEditController
): React.JSX.Element {
  const {
    statePending,
    states,
    localState,
    currentStateId,
    handleStateChange,
    priorityPending,
    localPriority,
    handlePriorityChange,
    estimatePopoverOpen,
    handleEstimatePopoverOpenChange,
    estimatePending,
    localEstimate,
    handleEstimateChange,
    estimateInput,
    setEstimateInput,
    handleEstimateSubmit,
    assigneePending,
    members,
    localAssignee,
    handleAssigneeChange,
    labelPopoverOpen,
    setLabelPopoverOpen,
    labelsPending,
    localLabels,
    labelSummary,
    labels,
    localLabelIds,
    handleLabelToggle,
    checkIcon
  } = controller

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border/60 px-4 py-2.5">
      {/* Status */}
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            disabled={statePending}
            className={LINEAR_EDIT_CHIP_CLASS}
            style={getLinearStatePillStyle(localState.color)}
            aria-busy={statePending || states.loading}
          >
            <span
              className="inline-block size-2 shrink-0 rounded-full"
              style={getLinearStateMarkerStyle(localState.color)}
            />
            <span className="truncate">{localState.name}</span>
            <LinearEditChipAdornment loading={states.loading} pending={statePending} />
          </button>
        </PopoverTrigger>
        <PopoverContent className="popover-scroll-content scrollbar-sleek w-48 p-1" align="start">
          {states.error ? (
            <div className="px-2 py-3 text-center text-[12px] text-destructive">{states.error}</div>
          ) : states.loading ? (
            <div className="flex items-center gap-2 px-2 py-3 text-[12px] text-muted-foreground">
              <LoaderCircle className="size-3 animate-spin" />
              {translate('auto.components.LinearItemDrawer.59b6cd3706', 'Loading states')}
            </div>
          ) : states.data.length > 0 ? (
            <div>
              {states.data.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => handleStateChange(s.id)}
                  className={cn(
                    LINEAR_EDIT_MENU_ITEM_WITH_ICON_CLASS,
                    currentStateId === s.id && 'bg-accent/50'
                  )}
                >
                  <span
                    className="inline-block size-2 rounded-full"
                    style={{ backgroundColor: s.color }}
                  />
                  {s.name}
                </button>
              ))}
            </div>
          ) : (
            <div className="px-2 py-3 text-center text-[12px] text-muted-foreground">
              {translate('auto.components.LinearItemDrawer.780ea6ed89', 'No states found')}
            </div>
          )}
        </PopoverContent>
      </Popover>

      {/* Priority */}
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            disabled={priorityPending}
            className={LINEAR_EDIT_CHIP_CLASS}
            aria-busy={priorityPending}
          >
            <LinearPriorityIcon priority={localPriority} />
            <span className="truncate">
              {PRIORITY_LABELS[localPriority] ?? `P${localPriority}`}
            </span>
            <LinearEditChipAdornment pending={priorityPending} />
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-36 p-1" align="start">
          {[0, 1, 2, 3, 4].map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => handlePriorityChange(String(p))}
              className={cn(
                LINEAR_EDIT_MENU_ITEM_WITH_ICON_CLASS,
                localPriority === p && 'bg-accent/50'
              )}
            >
              <LinearPriorityIcon priority={p} />
              {PRIORITY_LABELS[p]}
            </button>
          ))}
        </PopoverContent>
      </Popover>

      {/* Estimate */}
      <Popover open={estimatePopoverOpen} onOpenChange={handleEstimatePopoverOpenChange}>
        <PopoverTrigger asChild>
          <button
            type="button"
            disabled={estimatePending}
            className={LINEAR_EDIT_CHIP_CLASS}
            aria-busy={estimatePending}
          >
            <span className="truncate">{formatLinearEstimateLabel(localEstimate)}</span>
            <LinearEditChipAdornment pending={estimatePending} />
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-64 p-3" align="start">
          <div className="space-y-3">
            <div className="grid grid-cols-5 gap-1.5">
              {LINEAR_ESTIMATE_PRESETS.map((estimate) => (
                <button
                  key={estimate}
                  type="button"
                  onClick={() => handleEstimateChange(estimate)}
                  className={cn(
                    'flex h-8 items-center justify-center rounded-md border border-border text-sm hover:bg-accent',
                    localEstimate === estimate && 'border-primary bg-accent text-foreground'
                  )}
                >
                  {estimate}
                </button>
              ))}
            </div>
            <Input
              value={estimateInput}
              onChange={(event) => setEstimateInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  handleEstimateSubmit()
                }
              }}
              inputMode="numeric"
              placeholder={translate(
                'auto.components.LinearItemDrawer.fbb90300e2',
                'Custom estimate'
              )}
              className="h-8 text-sm"
            />
            <div className="flex items-center justify-between gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => handleEstimateChange(null)}
              >
                {translate('auto.components.LinearItemDrawer.ceeb8c6153', 'Clear')}
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={handleEstimateSubmit}
                disabled={estimatePending}
              >
                {estimatePending ? <LoaderCircle className="size-3.5 animate-spin" /> : null}
                {translate('auto.components.LinearItemDrawer.b5675b0694', 'Save')}
              </Button>
            </div>
          </div>
        </PopoverContent>
      </Popover>

      {/* Assignee */}
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            disabled={assigneePending}
            className={LINEAR_EDIT_CHIP_CLASS}
            aria-busy={assigneePending || members.loading}
          >
            <span className="truncate">
              {localAssignee
                ? localAssignee.displayName
                : translate('auto.components.LinearItemDrawer.d71cd3003e', '+ Assignee')}
            </span>
            <LinearEditChipAdornment loading={members.loading} pending={assigneePending} />
          </button>
        </PopoverTrigger>
        <PopoverContent className="popover-scroll-content scrollbar-sleek w-48 p-1" align="start">
          <div>
            <button
              type="button"
              onClick={() => handleAssigneeChange('__unassign__')}
              className={cn(LINEAR_EDIT_MENU_ITEM_CLASS, !localAssignee && 'bg-accent/50')}
            >
              {translate('auto.components.LinearItemDrawer.866316f22c', 'Unassigned')}
            </button>
            {members.error ? (
              <div className="px-2 py-3 text-center text-[12px] text-destructive">
                {members.error}
              </div>
            ) : members.loading ? (
              <div className="flex items-center gap-2 px-2 py-3 text-[12px] text-muted-foreground">
                <LoaderCircle className="size-3 animate-spin" />
                {translate('auto.components.LinearItemDrawer.b2376d0179', 'Loading members')}
              </div>
            ) : (
              members.data.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => handleAssigneeChange(m.id)}
                  className={cn(
                    LINEAR_EDIT_MENU_ITEM_CLASS,
                    localAssignee?.id === m.id && 'bg-accent/50'
                  )}
                >
                  {m.displayName}
                </button>
              ))
            )}
          </div>
        </PopoverContent>
      </Popover>

      {/* Labels */}
      <Popover open={labelPopoverOpen} onOpenChange={setLabelPopoverOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            disabled={labelsPending}
            className={LINEAR_EDIT_CHIP_CLASS}
            aria-label={
              localLabels.length
                ? translate('auto.components.LinearItemDrawer.7f7b89b631', 'Labels: {{value0}}', {
                    value0: localLabels.join(', ')
                  })
                : translate('auto.components.LinearItemDrawer.23886c7eec', 'Add label')
            }
            aria-busy={labelsPending || labels.loading}
          >
            <span className="truncate">{labelSummary}</span>
            <LinearEditChipAdornment loading={labels.loading} pending={labelsPending} />
          </button>
        </PopoverTrigger>
        <PopoverContent className="popover-scroll-content scrollbar-sleek w-52 p-1" align="start">
          {labels.error ? (
            <div className="px-2 py-3 text-center text-[12px] text-destructive">{labels.error}</div>
          ) : labels.loading ? (
            <div className="flex items-center gap-2 px-2 py-3 text-[12px] text-muted-foreground">
              <LoaderCircle className="size-3 animate-spin" />
              {translate('auto.components.LinearItemDrawer.cddd9b04a7', 'Loading labels')}
            </div>
          ) : labels.data.length > 0 ? (
            <div>
              {labels.data.map((label) => (
                <button
                  key={label.id}
                  type="button"
                  onClick={() => handleLabelToggle(label.id)}
                  className={LINEAR_EDIT_MENU_ITEM_WITH_ICON_CLASS}
                >
                  <span
                    className={cn(
                      'flex size-3.5 items-center justify-center rounded-sm border',
                      localLabelIds.includes(label.id)
                        ? 'border-primary bg-primary text-primary-foreground'
                        : 'border-input'
                    )}
                  >
                    {localLabelIds.includes(label.id) && checkIcon}
                  </span>
                  <span
                    className="inline-block size-2 rounded-full"
                    style={{ backgroundColor: label.color }}
                  />
                  {label.name}
                </button>
              ))}
            </div>
          ) : (
            <div className="px-2 py-3 text-center text-[12px] text-muted-foreground">
              {translate('auto.components.LinearItemDrawer.367f828482', 'No labels found')}
            </div>
          )}
        </PopoverContent>
      </Popover>
    </div>
  )
}
