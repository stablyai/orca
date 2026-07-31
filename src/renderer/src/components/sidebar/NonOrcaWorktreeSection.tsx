import React, { useState } from 'react'
import { ChevronDown, ChevronRight, Eye, EyeOff } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { translate } from '@/i18n/i18n'
import NonOrcaWorktreeRowList from './NonOrcaWorktreeRowList'
import type { NonOrcaWorktreeRow } from './non-orca-worktree-visibility-candidates'

type NonOrcaWorktreeSectionProps = {
  title: string
  description: string
  anyShown: boolean
  stateLabel: string
  countLabel: string
  bulkActionLabel: string
  bulkActionDisabled?: boolean
  onBulkAction: () => void
  rows: readonly NonOrcaWorktreeRow[]
  busyPath: string | null
  pending: boolean
  onToggleVisibility: (row: NonOrcaWorktreeRow) => void
}

export default function NonOrcaWorktreeSection({
  title,
  description,
  anyShown,
  stateLabel,
  countLabel,
  bulkActionLabel,
  bulkActionDisabled = false,
  onBulkAction,
  rows,
  busyPath,
  pending,
  onToggleVisibility
}: NonOrcaWorktreeSectionProps): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  return (
    <section className="grid min-w-0 gap-2">
      <div className="grid min-w-0 gap-1">
        <h3 className="text-sm font-medium">{title}</h3>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <div
        aria-busy={pending}
        className="min-w-0 divide-y divide-border rounded-lg border border-border"
      >
        <div className="flex min-w-0 items-center gap-3 p-3">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-background text-muted-foreground">
            {anyShown ? <Eye className="size-4" /> : <EyeOff className="size-4" />}
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium">{stateLabel}</div>
            <div className="text-xs text-muted-foreground">{countLabel}</div>
          </div>
          <Button
            type="button"
            variant={anyShown ? 'ghost' : 'outline'}
            size="sm"
            disabled={pending || bulkActionDisabled}
            onClick={onBulkAction}
          >
            {bulkActionLabel}
          </Button>
        </div>
        {rows.length > 0 ? (
          <Collapsible open={expanded} onOpenChange={setExpanded}>
            <CollapsibleTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                className="h-9 w-full justify-start rounded-none px-3 text-left font-normal"
              >
                {expanded ? (
                  <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
                ) : (
                  <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
                )}
                <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                  {translate(
                    'auto.components.sidebar.NonOrcaWorktreeSection.7f40b18e35',
                    'Manage individually'
                  )}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">{rows.length}</span>
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="border-t border-border">
              <NonOrcaWorktreeRowList
                rows={rows}
                busyPath={busyPath}
                pending={pending}
                onToggleVisibility={onToggleVisibility}
              />
            </CollapsibleContent>
          </Collapsible>
        ) : null}
      </div>
    </section>
  )
}
