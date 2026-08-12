import React from 'react'
import { ArrowRight } from 'lucide-react'

import { translate } from '@/i18n/i18n'
import type { BeadsIssueRelation } from '../../../shared/beads-types'
import type { BeadsRelationGroup, BeadsRelationGroupKind } from './task-page-beads-relation-groups'
import { BEADS_STATUS_ICONS } from './task-page-beads-status-visuals'

function getBeadsRelationGroupLabel(kind: BeadsRelationGroupKind): string {
  switch (kind) {
    case 'parent':
      return translate('auto.components.TaskPage.beadsRelationParent', 'Parent')
    case 'sub-issues':
      return translate('auto.components.TaskPage.beadsRelationSubIssues', 'Sub-issues')
    case 'blocked-by':
      return translate('auto.components.TaskPage.beadsRelationBlockedBy', 'Blocked by')
    case 'blocks':
      return translate('auto.components.TaskPage.beadsRelationBlocks', 'Blocks')
    case 'related':
      return translate('auto.components.TaskPage.beadsRelationRelated', 'Related')
  }
}

/** Placeholder shown between the meta band and the body while relations load. */
export function BeadsItemDetailRelationsSkeleton(): React.JSX.Element {
  return (
    <div data-testid="beads-relations-skeleton" className="space-y-2">
      <div className="h-3 w-24 animate-pulse rounded bg-muted/60" />
      <div className="h-8 w-full animate-pulse rounded-md bg-muted/40" />
    </div>
  )
}

/** Linear-sub-issues-style relation rows grouped by edge kind; each row navigates the open dialog. */
export function BeadsItemDetailRelations({
  groups,
  onNavigate
}: {
  groups: BeadsRelationGroup[]
  onNavigate: (issue: BeadsIssueRelation) => void
}): React.JSX.Element {
  return (
    <div className="space-y-4">
      {groups.map((group) => (
        <section key={group.kind} className="min-w-0">
          <div className="mb-1 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
            {getBeadsRelationGroupLabel(group.kind)}
            <span className="rounded-full border border-border/50 bg-muted/30 px-1.5 py-0.5 font-normal normal-case tabular-nums">
              {group.relations.length}
            </span>
          </div>
          <div className="space-y-1">
            {group.relations.map((relation) => {
              const StatusIcon = BEADS_STATUS_ICONS[relation.status]
              return (
                <button
                  key={`${group.kind}:${relation.id}`}
                  type="button"
                  onClick={() => onNavigate(relation)}
                  className="flex min-h-8 w-full min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left text-sm text-muted-foreground transition hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  <StatusIcon className="size-3.5 shrink-0" />
                  <span className="shrink-0 font-mono text-xs">{relation.id}</span>
                  <span className="min-w-0 flex-1 truncate">{relation.title}</span>
                  <span className="inline-flex shrink-0 items-center rounded-full border border-border/50 bg-muted/40 px-2 py-0.5 text-[11px] font-medium text-foreground">
                    {relation.issueType}
                  </span>
                  <ArrowRight className="size-3.5 shrink-0" />
                </button>
              )
            })}
          </div>
        </section>
      ))}
    </div>
  )
}
