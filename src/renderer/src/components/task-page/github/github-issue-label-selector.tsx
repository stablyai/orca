import React, { useCallback, useId, useMemo } from 'react'
import { Check, LoaderCircle } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'

export function GitHubIssueLabelSelector({
  labels,
  selectedLabels,
  loading,
  error,
  disabled,
  onChange
}: {
  labels: string[]
  selectedLabels: string[]
  loading: boolean
  error: string | null
  disabled: boolean
  onChange: (labels: string[]) => void
}): React.JSX.Element {
  const selectedSet = useMemo(() => new Set(selectedLabels), [selectedLabels])
  const toggleLabel = useCallback(
    (label: string) => {
      onChange(
        selectedSet.has(label)
          ? selectedLabels.filter((name) => name !== label)
          : [...selectedLabels, label]
      )
    },
    [onChange, selectedLabels, selectedSet]
  )

  // Why: name the trigger with both nodes so the field label and current selection are announced.
  const selectorId = useId()
  const labelId = `labels-label-${selectorId}`
  const triggerId = `labels-trigger-${selectorId}`

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span id={labelId} className="text-[11px] font-medium text-muted-foreground">
        {translate('auto.components.TaskPage.d0ca4aa1d0', 'Labels')}
      </span>
      <Popover>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            disabled={disabled}
            id={triggerId}
            aria-labelledby={`${labelId} ${triggerId}`}
            className="h-auto min-h-9 justify-start gap-2 px-3 py-2 text-left"
          >
            {selectedLabels.length === 0 ? (
              <span className="text-muted-foreground">
                {translate('auto.components.TaskPage.5ebff3a0aa', 'None')}
              </span>
            ) : (
              <span className="flex min-w-0 flex-wrap gap-1.5">
                {selectedLabels.map((label) => (
                  <span
                    key={label}
                    className="rounded-full border border-border/50 bg-muted/40 px-2 py-0.5 text-[11px] font-medium"
                  >
                    {label}
                  </span>
                ))}
              </span>
            )}
            {loading ? <LoaderCircle className="ml-auto size-3.5 animate-spin" /> : null}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="popover-scroll-content scrollbar-sleek w-64 p-1" align="start">
          {error ? (
            <div className="px-2 py-2 text-xs text-destructive">{error}</div>
          ) : loading && labels.length === 0 ? (
            <div className="px-2 py-2 text-xs text-muted-foreground">
              {translate(
                'auto.components.task.page.github.github.issue.label.selector.2a1862c470',
                'Loading labels…'
              )}
            </div>
          ) : labels.length === 0 ? (
            <div className="px-2 py-2 text-xs text-muted-foreground">
              {translate('auto.components.TaskPage.b36f4bf9de', 'No labels.')}
            </div>
          ) : (
            labels.map((label) => (
              <button
                key={label}
                type="button"
                aria-pressed={selectedSet.has(label)}
                onClick={() => toggleLabel(label)}
                className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs hover:bg-accent"
              >
                <span
                  className={cn(
                    'flex size-3.5 shrink-0 items-center justify-center rounded-sm border',
                    selectedSet.has(label)
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'border-input'
                  )}
                >
                  {selectedSet.has(label) ? <Check className="size-2.5" /> : null}
                </span>
                <span className="min-w-0 truncate">{label}</span>
              </button>
            ))
          )}
        </PopoverContent>
      </Popover>
    </div>
  )
}
