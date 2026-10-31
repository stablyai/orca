import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, ExternalLink, PanelRight, PanelRightClose } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type {
  OrchestrationCrewRow,
  OrchestrationCrewSnapshot
} from '../../../../shared/orchestration-crew'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { useOrchestrationCrew } from '../native-chat/use-orchestration-crew'
import { openOrchestrationCrewAgent } from '@/lib/open-agent-message-sender'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { hasVisibleOverlay } from '@/lib/visible-overlay'
import { isImeOwnedKeyboardEvent } from '@/lib/ime-composition-keyboard-event'
import { CrewRowDetails, CrewRowTime as Time } from './CrewRowDetails'
import { CrewRowMenu } from './CrewRowMenu'
import { CrewAgentAvatar } from './CrewAgentAvatar'

function IconButton({
  label,
  children,
  ...props
}: React.ComponentProps<typeof Button> & { label: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon-xs" aria-label={label} {...props}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}

function runningWorker(row: OrchestrationCrewRow): boolean {
  return Boolean(
    row.sendAddress &&
    row.task &&
    !['completed', 'failed'].includes(row.task.state) &&
    (row.task.state === 'dispatched' || ['working', 'waiting', 'blocked'].includes(row.status))
  )
}

type PanelProps = {
  target: RuntimeClientTarget
  party: string
  canMention: boolean
  mention: (rows: OrchestrationCrewRow[]) => void
  isVisible?: boolean
}
export function OrchestrationCrewPanel(props: PanelProps): React.JSX.Element | null {
  const snapshot = useOrchestrationCrew(props.target, props.party)
  return <CrewPanelContent {...props} snapshot={snapshot} />
}

export function CrewPanelContent({
  target,
  canMention,
  mention,
  snapshot,
  isVisible = true
}: PanelProps & { snapshot: OrchestrationCrewSnapshot }): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const tab = useRef<HTMLButtonElement>(null)
  const collapse = useRef<HTMLButtonElement>(null)
  const restore = useRef(false)
  useLayoutEffect(() => {
    if (open) {
      collapse.current?.focus({ preventScroll: true })
    } else if (restore.current) {
      tab.current?.focus({ preventScroll: true })
    }
  }, [open])
  const { managedBy, managing, talkingWith } = snapshot.sections
  const all = [...managedBy, ...managing, ...talkingWith]
  const visible = snapshot.status === 'ok' && all.length > 0
  useEffect(() => {
    const pane =
      root.current?.closest<HTMLElement>('[data-native-chat-root], .pane') ?? root.current
    if (!open || !visible || !pane) {
      return
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.key !== 'Escape' ||
        event.defaultPrevented ||
        isImeOwnedKeyboardEvent(event) ||
        hasVisibleOverlay()
      ) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      restore.current = true
      setOpen(false)
    }
    pane.addEventListener('keydown', onKeyDown, true)
    return () => pane.removeEventListener('keydown', onKeyDown, true)
  }, [open, visible])
  if (!visible) {
    return null
  }
  const seen = new Set<string>()
  const summary = all.filter((row) => {
    if (seen.has(row.partyKey)) {
      return false
    }
    seen.add(row.partyKey)
    return true
  })
  const pending = new Set(all.filter((row) => row.pendingQuestion).map((row) => row.partyKey)).size
  const label = managing.length
    ? translate('components.orchestrationCrew.workers', '{{total}} workers', {
        total: managing.length
      })
    : managedBy.length
      ? translate('components.orchestrationCrew.managedByNames', 'Managed by {{names}}', {
          names: managedBy[0].label
        })
      : translate('components.orchestrationCrew.talkingWithNames', 'Talking with {{names}}', {
          names: talkingWith[0].label
        })
  const changeOpen = (value: boolean) => {
    restore.current = true
    setOpen(value)
  }
  const sections = [
    ['Managed by', translate('components.orchestrationCrew.managedBy', 'Managed by'), managedBy],
    ['Managing', translate('components.orchestrationCrew.managing', 'Managing'), managing],
    [
      'Talking with',
      translate('components.orchestrationCrew.talkingWith', 'Talking with'),
      talkingWith
    ]
  ] as const
  return (
    <div
      ref={root}
      data-orchestration-crew
      data-pane-prevent-terminal-focus
      data-native-chat-typing-redirect-ignore="true"
      className="pointer-events-none absolute bottom-0 top-(--orca-pane-title-height) right-0 z-30 w-80 max-w-full text-foreground"
      onMouseDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation()
      }}
    >
      {open ? (
        <aside
          aria-label={translate('components.orchestrationCrew.label', 'Agent crew')}
          className="pointer-events-auto flex h-full w-full flex-col border-l border-border bg-card text-card-foreground shadow-xs"
        >
          <div className="flex h-9 shrink-0 items-center justify-between border-b border-border px-2">
            <span className="text-xs font-medium">
              {translate('components.orchestrationCrew.title', 'Orchestration')}
            </span>
            <IconButton
              ref={collapse}
              label={translate('components.orchestrationCrew.collapse', 'Collapse crew panel')}
              onClick={() => changeOpen(false)}
            >
              <PanelRightClose />
            </IconButton>
          </div>
          <div className="scrollbar-sleek min-h-0 flex-1 overflow-y-auto">
            {sections.map(([key, title, rows]) =>
              rows.length > 0 ? (
                <section key={key} aria-label={title}>
                  <div className="flex items-center gap-1.5 px-3 pb-1 pt-3 text-2xs font-semibold text-muted-foreground">
                    <span className="uppercase tracking-wider">{title}</span>
                    <span className="tracking-wider">{rows.length}</span>
                    {key === 'Managing' ? (
                      <Button
                        variant="ghost"
                        size="xs"
                        className="ml-auto"
                        disabled={!canMention || !rows.some(runningWorker)}
                        onClick={() => mention(rows.filter(runningWorker))}
                      >
                        {translate('components.orchestrationCrew.mentionAll', 'Mention all')}
                      </Button>
                    ) : null}
                  </div>
                  {rows.map((row) => (
                    <CrewRowView
                      key={row.partyKey}
                      row={row}
                      target={target}
                      isVisible={isVisible}
                      canMention={canMention}
                      mention={() => mention([row])}
                    />
                  ))}
                </section>
              ) : null
            )}
          </div>
        </aside>
      ) : (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              ref={tab}
              variant="outline"
              size="xs"
              className="pointer-events-auto absolute right-0 top-2 h-auto max-w-full"
              aria-label={translate('components.orchestrationCrew.show', 'Show crew: {{label}}', {
                label
              })}
              aria-expanded={false}
              onClick={() => changeOpen(true)}
            >
              <PanelRight />
              <span className="flex -space-x-2">
                {summary.slice(0, 3).map((row) => (
                  <CrewAgentAvatar key={row.partyKey} row={row} target={target} />
                ))}
              </span>
              <span className="truncate">{label}</span>
              {pending > 0 ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Badge variant="outline">
                      <span className="text-status-warning">{pending}</span>
                    </Badge>
                  </TooltipTrigger>
                  <TooltipContent>
                    {translate(
                      'components.orchestrationCrew.pending',
                      '{{pending}} waiting for you',
                      { pending }
                    )}
                  </TooltipContent>
                </Tooltip>
              ) : null}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>
            {translate('components.orchestrationCrew.title', 'Orchestration')}
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  )
}

function CrewRowView({
  row,
  target,
  canMention,
  mention,
  isVisible
}: {
  row: OrchestrationCrewRow
  target: RuntimeClientTarget
  canMention: boolean
  mention: () => void
  isVisible: boolean
}) {
  const [disclosure, setDisclosure] = useState<{ question?: string; expanded: boolean }>()
  const question = row.pendingQuestion?.at
  const expanded =
    disclosure?.question === question
      ? (disclosure?.expanded ?? Boolean(question))
      : Boolean(question)
  const open = () => {
    void openOrchestrationCrewAgent(row, target)
  }
  return (
    <div className="border-b border-border/50">
      <div className="flex items-center gap-1 px-2 py-2">
        <Button
          variant="ghost"
          size="xs"
          className="h-auto min-w-0 flex-1 justify-start text-left"
          disabled={!canMention || !row.sendAddress}
          onPointerDown={(event) => event.preventDefault()}
          onClick={mention}
        >
          <CrewAgentAvatar row={row} target={target} tooltip />
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5">
              <span className="truncate text-sm font-medium">{row.label}</span>
            </span>
            <span
              className={cn(
                'block truncate text-xs font-normal',
                row.pendingQuestion ? 'text-status-warning' : 'text-muted-foreground'
              )}
            >
              {row.pendingQuestion
                ? translate('components.orchestrationCrew.waitingPrefix', 'Waiting for you · ')
                : ''}
              {row.task?.title ??
                translate('components.orchestrationCrew.noTask', 'No shared task')}
            </span>
          </span>
        </Button>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <Time at={row.pendingQuestion?.at ?? row.latest?.at} />
          <div className="flex">
            <IconButton
              label={translate('components.orchestrationCrew.open', 'Open {{name}}', {
                name: row.label
              })}
              onClick={open}
            >
              <ExternalLink />
            </IconButton>
            {isVisible ? (
              <CrewRowMenu row={row} open={open} canMention={canMention} mention={mention} />
            ) : null}
            <IconButton
              label={translate(
                'components.orchestrationCrew.showDetails',
                "Show {{name}}'s task and latest message",
                { name: row.label }
              )}
              aria-expanded={expanded}
              onClick={() => setDisclosure({ question, expanded: !expanded })}
            >
              {expanded ? <ChevronDown /> : <ChevronRight />}
            </IconButton>
          </div>
        </div>
      </div>
      {!row.sendAddress ? (
        <p className="px-3 pb-2 text-xs text-muted-foreground">
          {translate('components.orchestrationCrew.sendingUnavailable', 'Sending unavailable')}
        </p>
      ) : null}
      {expanded ? <CrewRowDetails row={row} /> : null}
    </div>
  )
}
