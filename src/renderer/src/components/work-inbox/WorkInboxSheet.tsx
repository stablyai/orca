import React from 'react'
import { RefreshCw } from 'lucide-react'
import { WORK_INBOX_LIST_MAX } from '../../../../shared/work-inbox'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle
} from '@/components/ui/sheet'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { LoadingSpinner } from '@/components/LoadingSpinner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import {
  STATUS_BAR_RESERVE_HEIGHT,
  WORKSPACE_TOP_CHROME_HEIGHT
} from '../sidebar/workspace-chrome-metrics'
import type { WorkInboxController, WorkInboxFilterOption } from './use-work-inbox'
import { WorkInboxItemCard } from './WorkInboxItemCard'
import { openWorkInboxAgent } from './open-work-inbox-agent'

const ALL = '__all__'

function FilterSelect({
  label,
  allLabel,
  value,
  options,
  onChange
}: {
  label: string
  allLabel: string
  value: string | null
  options: WorkInboxFilterOption[]
  onChange: (value: string | null) => void
}): React.JSX.Element {
  // Why: a selected id can outlive the rows that named it (e.g. after a refresh); keep it selectable.
  const shown =
    value && !options.some((option) => option.id === value)
      ? [...options, { id: value, label: value }]
      : options
  return (
    <Select value={value ?? ALL} onValueChange={(next) => onChange(next === ALL ? null : next)}>
      <SelectTrigger size="sm" aria-label={label} className="w-48">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>{allLabel}</SelectItem>
        {shown.map((option) => (
          <SelectItem key={option.id} value={option.id}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

export function WorkInboxSheet({
  open,
  onOpenChange,
  inbox
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  inbox: WorkInboxController
}): React.JSX.Element {
  const statusBarVisible = useAppStore((s) => s.statusBarVisible)
  // Why: the sheet portals to body; without these bounds its header and close button sit under
  // the Windows/Linux titlebar controls and it covers the status bar (same as AgentDashboardDrawer).
  const bounds = {
    top: WORKSPACE_TOP_CHROME_HEIGHT,
    bottom: statusBarVisible ? STATUS_BAR_RESERVE_HEIGHT : 0
  }
  const [now, setNow] = React.useState(() => Date.now())
  React.useEffect(() => {
    if (open) {
      setNow(Date.now())
    }
  }, [open, inbox.items])

  const emptyCopy =
    inbox.view === 'open'
      ? translate(
          'auto.components.work-inbox.emptyOpen',
          'No agent is waiting on you. When an agent needs your decision, its question appears here.'
        )
      : translate('auto.components.work-inbox.emptyHistory', 'No answered or closed questions yet.')

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-2xl"
        overlayStyle={bounds}
        style={{ ...bounds, height: 'auto' }}
      >
        {/* Why: the right pad keeps the title clear of the sheet's close button. */}
        <div className="border-b border-border pr-8">
          <SheetHeader>
            <SheetTitle>{translate('auto.components.work-inbox.title', 'Work Inbox')}</SheetTitle>
            <SheetDescription>
              {translate(
                'auto.components.work-inbox.description',
                'Questions agents asked you. The asking agent continues after it receives your answer.'
              )}
            </SheetDescription>
          </SheetHeader>
        </div>

        <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
          <Tabs
            value={inbox.view}
            onValueChange={(next) => inbox.setView(next === 'history' ? 'history' : 'open')}
          >
            <TabsList>
              <TabsTrigger value="open">
                {translate('auto.components.work-inbox.tabOpen', 'Unanswered')}
                {inbox.openCount !== null ? ` (${inbox.openCount})` : ''}
              </TabsTrigger>
              <TabsTrigger value="history">
                {translate('auto.components.work-inbox.tabHistory', 'History')}
              </TabsTrigger>
            </TabsList>
          </Tabs>
          <FilterSelect
            label={translate('auto.components.work-inbox.filterProject', 'Filter by project')}
            allLabel={translate('auto.components.work-inbox.allProjects', 'All projects')}
            value={inbox.projectId}
            options={inbox.projectOptions}
            onChange={inbox.setProjectId}
          />
          <FilterSelect
            label={translate('auto.components.work-inbox.filterAgent', 'Filter by agent')}
            allLabel={translate('auto.components.work-inbox.allAgents', 'All agents')}
            value={inbox.agentId}
            options={inbox.agentOptions}
            onChange={inbox.setAgentId}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="ml-auto"
            disabled={inbox.loading}
            onClick={() => void inbox.reload()}
            aria-label={translate('auto.components.work-inbox.refresh', 'Refresh')}
          >
            {inbox.loading ? <LoadingSpinner className="size-4" /> : <RefreshCw />}
          </Button>
        </div>

        <div className="scrollbar-sleek min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
          {inbox.loadError ? (
            <div
              role="alert"
              className="flex items-center gap-3 rounded-md border border-destructive/40 px-3 py-2 text-sm text-destructive"
            >
              <span className="flex-1">
                {inbox.loadError === 'unsupported'
                  ? translate(
                      'auto.components.work-inbox.unsupported',
                      'The Orca version on this host does not support Work Inbox yet.'
                    )
                  : translate(
                      'auto.components.work-inbox.loadFailed',
                      'Could not load the inbox. Drafts are kept.'
                    )}
              </span>
              <Button type="button" size="sm" variant="outline" onClick={() => void inbox.reload()}>
                {translate('auto.components.work-inbox.retry', 'Retry')}
              </Button>
            </div>
          ) : null}

          {!inbox.hasLoaded && inbox.loading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
              <LoadingSpinner className="size-4" />
              {translate('auto.components.work-inbox.loading', 'Loading questions…')}
            </div>
          ) : null}

          {inbox.hasLoaded && inbox.items.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">{emptyCopy}</p>
          ) : null}

          {inbox.items.map((item) => (
            <WorkInboxItemCard
              key={item.id}
              item={item}
              draft={inbox.getDraft(item.id)}
              now={now}
              onDraftChange={(patch) => inbox.updateDraft(item.id, patch)}
              onSubmit={() => {
                const target = inbox.target
                void inbox.submitAnswer(item).then((answered) => {
                  if (answered && target) {
                    onOpenChange(false)
                    void openWorkInboxAgent(answered, target)
                  }
                })
              }}
              onStatusChange={() => void inbox.statusActions.change(item)}
              statusBusy={inbox.statusActions.state(item.id)?.busy}
              statusFailed={inbox.statusActions.state(item.id)?.failed}
            />
          ))}

          {inbox.canShowMore ? (
            <div className="flex justify-center">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={inbox.loading}
                onClick={inbox.showMore}
              >
                {translate('auto.components.work-inbox.showMore', 'Show more')}
              </Button>
            </div>
          ) : null}
          {inbox.items.length >= WORK_INBOX_LIST_MAX ? (
            <p className="text-center text-xs text-muted-foreground">
              {translate(
                'auto.components.work-inbox.capped',
                'Showing the first 200 questions. Filter by project or agent to see the rest.'
              )}
            </p>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  )
}
