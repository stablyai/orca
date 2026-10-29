import type { TaskPageComposerActionsModel } from '../use-task-page-composer-actions'
import React from 'react'
import DOMPurify, { type DOMPurify as DOMPurifyInstance } from 'dompurify'
import { ExternalLink, LoaderCircle, Play } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { translate } from '@/i18n/i18n'
import type {
  AzureDevOpsWorkItem,
  AzureDevOpsWorkItemDetail,
  AzureDevOpsWorkItemTypeMetadata
} from '../../../../../shared/azure-devops/boards-types'
import { WorkItemStateDot, WorkItemTagChip, WorkItemTypeBadge } from './WorkItemVisuals'

export type AzureDevOpsWorkItemDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  detail: AzureDevOpsWorkItemDetail | null
  loading: boolean
  error: string | null
  workItemTypes: Record<string, AzureDevOpsWorkItemTypeMetadata>
  tagColors: Record<string, string>
  parent: AzureDevOpsWorkItem | null
  childItems: AzureDevOpsWorkItem[]
  onOpenItem: (id: number) => void
  onUseItem: (id: number) => void
}

// Why: a private instance — the global DOMPurify is shared with MermaidBlock and
// notebook outputs, and hooks added to it would rewrite their links too.
let sanitizer: DOMPurifyInstance | null = null

function getSanitizer(): DOMPurifyInstance {
  if (!sanitizer) {
    sanitizer = DOMPurify(window)
    // Why: work item HTML comes from any project member; never let its links navigate the app.
    sanitizer.addHook('afterSanitizeAttributes', (node) => {
      if (node.tagName === 'A') {
        node.setAttribute('target', '_blank')
        node.setAttribute('rel', 'noopener noreferrer')
      }
    })
  }
  return sanitizer
}

export function sanitizeAzureDevOpsHtml(html: string): string {
  return getSanitizer().sanitize(html, {
    USE_PROFILES: { html: true },
    // Belt-and-braces: script is listed even though the html profile already drops it.
    FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed']
  })
}

function Field({
  label,
  children
}: {
  label: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate text-xs">{children}</span>
    </div>
  )
}

function HtmlSection({
  title,
  html
}: {
  title: string
  html: string | null
}): React.JSX.Element | null {
  if (!html) {
    return null
  }
  return (
    <section className="space-y-1">
      <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
      <div
        className="markdown-body text-sm"
        dangerouslySetInnerHTML={{ __html: sanitizeAzureDevOpsHtml(html) }}
      />
    </section>
  )
}

function RelatedItem({
  item,
  workItemTypes,
  onOpenItem
}: {
  item: AzureDevOpsWorkItem
  workItemTypes: Record<string, AzureDevOpsWorkItemTypeMetadata>
  onOpenItem: (id: number) => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left text-xs hover:bg-muted"
      onClick={() => onOpenItem(item.id)}
    >
      <WorkItemTypeBadge type={item.workItemType} metadata={workItemTypes[item.workItemType]} />
      <span className="tabular-nums text-muted-foreground">{item.id}</span>
      <span className="min-w-0 truncate">{item.title}</span>
      <WorkItemStateDot
        state={item.state}
        metadata={workItemTypes[item.workItemType]}
        className="ml-auto"
      />
    </button>
  )
}

export function AzureDevOpsWorkItemDialog(
  props: AzureDevOpsWorkItemDialogProps
): React.JSX.Element {
  const { detail } = props
  const metadata = detail ? props.workItemTypes[detail.workItemType] : undefined
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="flex max-h-[85vh] max-w-3xl flex-col overflow-hidden">
        <DialogHeader>
          {detail ? (
            <>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <WorkItemTypeBadge type={detail.workItemType} metadata={metadata} showName />
                <span className="tabular-nums">{detail.id}</span>
                <a
                  href={detail.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="ml-auto inline-flex items-center gap-1 hover:underline"
                >
                  {translate(
                    'auto.components.TaskPage.azureDevOps.openInAzure',
                    'Open in Azure DevOps'
                  )}
                  <ExternalLink className="size-3" />
                </a>
              </div>
              <DialogTitle>{detail.title}</DialogTitle>
            </>
          ) : (
            <DialogTitle>
              {props.error ??
                translate('auto.components.TaskPage.azureDevOps.loadingItem', 'Loading work item…')}
            </DialogTitle>
          )}
        </DialogHeader>

        {props.loading && !detail ? (
          <div className="flex items-center gap-2 py-6 text-xs text-muted-foreground">
            <LoaderCircle className="size-4 animate-spin" />
          </div>
        ) : null}

        {detail ? (
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto scrollbar-sleek pr-1">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Field label={translate('auto.components.TaskPage.azureDevOps.fieldState', 'State')}>
                <WorkItemStateDot state={detail.state} metadata={metadata} />
              </Field>
              <Field
                label={translate(
                  'auto.components.TaskPage.azureDevOps.fieldAssignedTo',
                  'Assigned to'
                )}
              >
                {detail.assignedTo?.displayName ??
                  translate('auto.components.TaskPage.azureDevOps.unassigned', 'Unassigned')}
              </Field>
              <Field label={translate('auto.components.TaskPage.azureDevOps.fieldArea', 'Area')}>
                {detail.areaPath}
              </Field>
              <Field
                label={translate(
                  'auto.components.TaskPage.azureDevOps.fieldIteration',
                  'Iteration'
                )}
              >
                {detail.iterationPath}
              </Field>
            </div>
            {detail.tags.length > 0 ? (
              <div className="flex flex-wrap gap-1">
                {detail.tags.map((tag) => (
                  <WorkItemTagChip key={tag} tag={tag} color={props.tagColors[tag] ?? null} />
                ))}
              </div>
            ) : null}
            <HtmlSection
              title={translate('auto.components.TaskPage.azureDevOps.description', 'Description')}
              html={detail.descriptionHtml}
            />
            <HtmlSection
              title={translate(
                'auto.components.TaskPage.azureDevOps.acceptanceCriteria',
                'Acceptance criteria'
              )}
              html={detail.acceptanceCriteriaHtml}
            />
            {props.parent ? (
              <section className="space-y-1">
                <h3 className="text-xs font-medium text-muted-foreground">
                  {translate('auto.components.TaskPage.azureDevOps.parent', 'Parent')}
                </h3>
                <RelatedItem
                  item={props.parent}
                  workItemTypes={props.workItemTypes}
                  onOpenItem={props.onOpenItem}
                />
              </section>
            ) : null}
            {props.childItems.length > 0 ? (
              <section className="space-y-1">
                <h3 className="text-xs font-medium text-muted-foreground">
                  {translate('auto.components.TaskPage.azureDevOps.children', 'Children')}
                </h3>
                {props.childItems.map((child) => (
                  <RelatedItem
                    key={child.id}
                    item={child}
                    workItemTypes={props.workItemTypes}
                    onOpenItem={props.onOpenItem}
                  />
                ))}
              </section>
            ) : null}
            {detail.pullRequestLinks.length > 0 ? (
              <section className="space-y-1">
                <h3 className="text-xs font-medium text-muted-foreground">
                  {translate('auto.components.TaskPage.azureDevOps.pullRequests', 'Pull requests')}
                </h3>
                {detail.pullRequestLinks.map((pr) => (
                  <a
                    key={pr.id}
                    href={pr.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block text-xs hover:underline"
                  >
                    {translate(
                      'auto.components.TaskPage.azureDevOps.pullRequestLabel',
                      'PR #{{value0}}',
                      { value0: String(pr.id) }
                    )}
                  </a>
                ))}
              </section>
            ) : null}
          </div>
        ) : null}

        {detail ? (
          <div className="flex justify-end border-t border-border/60 pt-3">
            <Button size="sm" onClick={() => props.onUseItem(detail.id)}>
              <Play className="size-3.5" />
              {translate('auto.components.TaskPage.azureDevOps.useInWorktree', 'Use in a worktree')}
            </Button>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

export function TaskPageAzureDevOpsWorkItemDialog({
  model
}: {
  model: TaskPageComposerActionsModel
}): React.JSX.Element {
  return <AzureDevOpsWorkItemDialog {...model.azureDevOpsViews.dialog} />
}
