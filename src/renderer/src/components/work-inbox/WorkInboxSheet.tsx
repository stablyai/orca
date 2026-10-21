import React from 'react'
import { isImeOwnedKeyboardEvent } from '@/lib/ime-composition-keyboard-event'
import { Pin, PinOff, RefreshCw, X } from 'lucide-react'
import { createPortal } from 'react-dom'
import { WorkInboxDockFrame } from './WorkInboxDockFrame'
import { WORK_INBOX_LIST_MAX } from '../../../../shared/work-inbox'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
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
import { LoadingSpinner } from '@/components/LoadingSpinner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import {
  STATUS_BAR_RESERVE_HEIGHT,
  WORKSPACE_TOP_CHROME_HEIGHT
} from '../sidebar/workspace-chrome-metrics'
import type { WorkInboxController, WorkInboxFilterOption } from './use-work-inbox'
import { WorkInboxItemCard } from './WorkInboxItemCard'

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
}): React.JSX.Element | null {
  const statusBarVisible = useAppStore((s) => s.statusBarVisible)
  const [pinned, setPinned] = React.useState(false)
  const [dockWidth, setDockWidth] = React.useState(420)
  const [dockTarget, setDockTarget] = React.useState<HTMLElement | null>(null)
  React.useEffect(() => {
    setDockTarget(document.getElementById('work-inbox-dock'))
  }, [])
  const docked = pinned && dockTarget !== null
  React.useEffect(() => {
    if (!open || !docked) {
      return
    }
    const close = (event: KeyboardEvent) => {
      if (
        event.key === 'Escape' &&
        !isImeOwnedKeyboardEvent(event) &&
        event.target instanceof Element &&
        event.target.closest('[data-work-inbox-dock]')
      ) {
        onOpenChange(false)
      }
    }
    document.addEventListener('keydown', close)
    return () => document.removeEventListener('keydown', close)
  }, [open, docked, onOpenChange])
  const Title = docked ? 'h2' : SheetTitle
  const Description = docked ? 'p' : SheetDescription
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
    inbox.view === 'history'
      ? translate('auto.components.work-inbox.emptyHistory', 'No answered or closed questions yet.')
      : translate(
          'auto.components.work-inbox.emptyOpen',
          'No agent is waiting on you. When an agent needs your decision, its question appears here.'
        )

  const content = (
    <>
      <div className="relative border-b border-border pr-20">
        <div className="absolute right-3 top-3 flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={
              docked
                ? translate('auto.components.work-inbox.unpin', 'Unpin inbox')
                : translate('auto.components.work-inbox.pin', 'Pin to right')
            }
            aria-pressed={docked}
            onClick={() => {
              if (!pinned) {
                useAppStore.getState().setRightSidebarOpen(false)
              }
              setPinned(!pinned)
            }}
          >
            {docked ? <PinOff /> : <Pin />}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={translate('auto.components.ui.sheet.1189e9fe0a', 'Close')}
            onClick={() => onOpenChange(false)}
          >
            <X />
          </Button>
        </div>
        <SheetHeader>
          <Title className="text-base font-semibold text-foreground">
            {translate('auto.components.work-inbox.title', 'Work Inbox')}
          </Title>
          <Description className="text-sm text-muted-foreground">
            {translate(
              'auto.components.work-inbox.description',
              'Questions agents asked you. The asking agent continues after it receives your answer.'
            )}
          </Description>
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

        {inbox.receipt ? (
          <p role="status" className="text-sm text-muted-foreground">
            {inbox.receipt.item.status === 'delivered'
              ? translate('auto.components.work-inbox.statusDelivered', 'Agent received')
              : inbox.receipt.unavailable
                ? translate(
                    'auto.components.work-inbox.receiptUnavailable',
                    'Could not confirm agent receipt. Your saved answer is kept; checking again automatically.'
                  )
                : translate(
                    'auto.components.work-inbox.statusAnswered',
                    'Answer saved — waiting for agent'
                  )}
          </p>
        ) : null}

        {inbox.items.map((item) => (
          <WorkInboxItemCard
            key={item.id}
            item={item}
            draft={inbox.getDraft(item.id)}
            now={now}
            onDraftChange={(patch) => inbox.updateDraft(item.id, patch)}
            onSubmit={() => void inbox.submitAnswer(item)}
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
    </>
  )

  if (docked && dockTarget) {
    return open
      ? createPortal(
          <WorkInboxDockFrame width={dockWidth} setWidth={setDockWidth}>
            {content}
          </WorkInboxDockFrame>,
          dockTarget
        )
      : null
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-2xl"
        showCloseButton={false}
        overlayStyle={bounds}
        style={{ ...bounds, height: 'auto' }}
      >
        {content}
      </SheetContent>
    </Sheet>
  )
}
