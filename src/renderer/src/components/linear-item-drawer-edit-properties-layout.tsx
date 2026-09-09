import React from 'react'
import { ChevronDown, Gauge, LoaderCircle, Tag, UserRound } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { getLinearStateMarkerStyle } from '@/components/linear-state-pill-style'
import { LinearPriorityIcon } from '@/components/linear-priority-icon'
import { translate } from '@/i18n/i18n'
import {
  LINEAR_EDIT_MENU_ITEM_CLASS,
  LINEAR_EDIT_MENU_ITEM_WITH_ICON_CLASS,
  LINEAR_ESTIMATE_PRESETS,
  LinearEditChipAdornment,
  PRIORITY_LABELS,
  formatLinearEstimateLabel
} from '@/components/linear-item-drawer-edit-controls'
import type { LinearIssueEditController } from '@/components/linear-item-drawer-edit-controller'

export function renderLinearIssuePropertiesLayout(
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
    assigneePending,
    members,
    localAssignee,
    handleAssigneeChange,
    estimatePopoverOpen,
    handleEstimatePopoverOpenChange,
    estimatePending,
    localEstimate,
    handleEstimateChange,
    estimateInput,
    setEstimateInput,
    handleEstimateSubmit,
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

  const propertyRowClass =
    'flex min-h-9 w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-foreground transition hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-80'
  const propertyIconClass = 'size-4 shrink-0 text-muted-foreground'

  return (
    <div className="space-y-3">
      <section className="rounded-xl border border-border/60 bg-card text-card-foreground shadow-xs">
        <div className="flex h-10 items-center gap-1 border-b border-border/50 px-4 text-sm font-medium text-muted-foreground">
          <span>{translate('auto.components.LinearItemDrawer.dd304de85a', 'Properties')}</span>
          <ChevronDown className="size-3.5" />
        </div>
        <div className="space-y-1 p-3">
          <Popover>
            <PopoverTrigger asChild>
              <button
                type="button"
                disabled={statePending}
                className={propertyRowClass}
                aria-busy={statePending || states.loading}
              >
                <span
                  className="inline-block size-2.5 shrink-0 rounded-full"
                  style={getLinearStateMarkerStyle(localState.color)}
                />
                <span className="min-w-0 flex-1 truncate">{localState.name}</span>
                <LinearEditChipAdornment loading={states.loading} pending={statePending} />
              </button>
            </PopoverTrigger>
            <PopoverContent
              className="popover-scroll-content scrollbar-sleek w-48 p-1"
              align="start"
            >
              {states.error ? (
                <div className="px-2 py-3 text-center text-[12px] text-destructive">
                  {states.error}
                </div>
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

          <Popover>
            <PopoverTrigger asChild>
              <button
                type="button"
                disabled={priorityPending}
                className={propertyRowClass}
                aria-busy={priorityPending}
              >
                <LinearPriorityIcon priority={localPriority} />
                <span className="min-w-0 flex-1 truncate">
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

          <Popover>
            <PopoverTrigger asChild>
              <button
                type="button"
                disabled={assigneePending}
                className={propertyRowClass}
                aria-busy={assigneePending || members.loading}
              >
                {localAssignee?.avatarUrl ? (
                  <img
                    src={localAssignee.avatarUrl}
                    alt=""
                    className="size-4 shrink-0 rounded-full"
                  />
                ) : (
                  <UserRound className={propertyIconClass} />
                )}
                <span className="min-w-0 flex-1 truncate">
                  {localAssignee
                    ? localAssignee.displayName
                    : translate('auto.components.LinearItemDrawer.866316f22c', 'Unassigned')}
                </span>
                <LinearEditChipAdornment loading={members.loading} pending={assigneePending} />
              </button>
            </PopoverTrigger>
            <PopoverContent
              className="popover-scroll-content scrollbar-sleek w-48 p-1"
              align="start"
            >
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

          <Popover open={estimatePopoverOpen} onOpenChange={handleEstimatePopoverOpenChange}>
            <PopoverTrigger asChild>
              <button
                type="button"
                disabled={estimatePending}
                className={propertyRowClass}
                aria-busy={estimatePending}
              >
                <Gauge className={propertyIconClass} />
                <span className="min-w-0 flex-1 truncate">
                  {formatLinearEstimateLabel(localEstimate)}
                </span>
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
        </div>
      </section>

      <section className="rounded-xl border border-border/60 bg-card text-card-foreground shadow-xs">
        <div className="flex h-10 items-center gap-1 border-b border-border/50 px-4 text-sm font-medium text-muted-foreground">
          <span>{translate('auto.components.LinearItemDrawer.64bfffc4dd', 'Labels')}</span>
          <ChevronDown className="size-3.5" />
        </div>
        <div className="p-3">
          <Popover open={labelPopoverOpen} onOpenChange={setLabelPopoverOpen}>
            <PopoverTrigger asChild>
              <button
                type="button"
                disabled={labelsPending}
                className={propertyRowClass}
                aria-label={
                  localLabels.length
                    ? translate(
                        'auto.components.LinearItemDrawer.7f7b89b631',
                        'Labels: {{value0}}',
                        { value0: localLabels.join(', ') }
                      )
                    : translate('auto.components.LinearItemDrawer.23886c7eec', 'Add label')
                }
                aria-busy={labelsPending || labels.loading}
              >
                <Tag className={propertyIconClass} />
                <span className="min-w-0 flex-1 truncate">
                  {localLabels.length
                    ? labelSummary
                    : translate('auto.components.LinearItemDrawer.23886c7eec', 'Add label')}
                </span>
                <LinearEditChipAdornment loading={labels.loading} pending={labelsPending} />
              </button>
            </PopoverTrigger>
            <PopoverContent
              className="popover-scroll-content scrollbar-sleek w-52 p-1"
              align="start"
            >
              {labels.error ? (
                <div className="px-2 py-3 text-center text-[12px] text-destructive">
                  {labels.error}
                </div>
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
      </section>
    </div>
  )
}
