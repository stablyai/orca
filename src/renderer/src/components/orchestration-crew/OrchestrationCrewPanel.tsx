import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  ExternalLink,
  PanelRight,
  PanelRightClose,
  Workflow
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import StatusIndicator from '@/components/sidebar/StatusIndicator'
import { formatStateCount } from '@/components/sidebar/worktree-card-agent-summary'
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
import {
  CREW_STATUS_GROUPS,
  CrewAgentIcons,
  CrewAgentStack,
  crewStatusGroup,
  useCrewRowLooks,
  type CrewRowLook,
  type CrewStatusGroup
} from './CrewAgentIcons'

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

const GROUP_DOT = {
  needsYou: 'permission',
  working: 'working',
  idle: 'idle',
  failed: 'failed'
} as const satisfies Record<CrewStatusGroup, Parameters<typeof formatStateCount>[0]>

/** Most recent traffic first; the read model keeps one latest message per row, either direction. */
function sortCrewRows(rows: readonly OrchestrationCrewRow[]): OrchestrationCrewRow[] {
  return rows
    .map((row, index) => ({ row, index }))
    .sort(
      (a, b) =>
        (b.row.latest?.sequence ?? -Infinity) - (a.row.latest?.sequence ?? -Infinity) ||
        a.index - b.index
    )
    .map(({ row }) => row)
}

function crewTabSummary(
  workers: number,
  looks: readonly CrewRowLook[]
): { groups: { group: CrewStatusGroup; looks: CrewRowLook[] }[]; counts: string } {
  const byGroup = new Map<CrewStatusGroup, CrewRowLook[]>()
  for (const look of looks) {
    const group = crewStatusGroup(look.status)
    const members = byGroup.get(group)
    if (members) {
      members.push(look)
    } else {
      byGroup.set(group, [look])
    }
  }
  const groups = CREW_STATUS_GROUPS.flatMap((group) => {
    const members = byGroup.get(group)
    return members ? [{ group, looks: members }] : []
  })
  const counts = [
    ...(workers > 0
      ? [
          translate('components.orchestrationCrew.workers', '{{count}} workers', {
            count: workers,
            defaultValue_one: '{{count}} worker'
          })
        ]
      : []),
    ...groups.map(({ group, looks: members }) => formatStateCount(GROUP_DOT[group], members.length))
  ].join(', ')
  return { groups, counts }
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
  const { managedBy, managing, talkingWith } = useMemo(
    () => ({
      managedBy: sortCrewRows(snapshot.sections.managedBy),
      managing: sortCrewRows(snapshot.sections.managing),
      talkingWith: sortCrewRows(snapshot.sections.talkingWith)
    }),
    [snapshot]
  )
  // One row per party: a party in two sections shows once in the tab and keeps one look.
  const parties = useMemo(() => {
    const seen = new Set<string>()
    return [...managedBy, ...managing, ...talkingWith].filter((row) => {
      if (seen.has(row.partyKey)) {
        return false
      }
      seen.add(row.partyKey)
      return true
    })
  }, [managedBy, managing, talkingWith])
  const looks = useCrewRowLooks(parties, target)
  const lookByParty = useMemo(
    () => new Map(parties.map((row, index) => [row.partyKey, looks[index]])),
    [parties, looks]
  )
  const visible = snapshot.status === 'ok' && parties.length > 0
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
  const summary = crewTabSummary(managing.length, looks)
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
  const title = translate('components.orchestrationCrew.title', 'Orchestration')
  return (
    <div
      ref={root}
      data-orchestration-crew
      data-pane-prevent-terminal-focus
      data-native-chat-typing-redirect-ignore="true"
      // A chat's own header is opaque, so the panel starts under it; elsewhere it reaches the pane top.
      className="pointer-events-none absolute bottom-0 top-[var(--native-chat-header-inset,0px)] right-0 z-30 w-80 max-w-full text-foreground"
      onMouseDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation()
      }}
    >
      {open ? (
        <aside
          aria-label={title}
          // The pane's transparent title strip draws its buttons over this band, so no chat shows above the panel.
          className="pointer-events-auto flex h-full w-full flex-col border-l border-border bg-card pt-[calc(var(--orca-pane-title-height)-var(--native-chat-header-inset,0px))] text-card-foreground shadow-xs"
        >
          <div className="flex h-9 shrink-0 items-center justify-between border-b border-border px-2">
            <span className="text-xs font-medium">{title}</span>
            <IconButton
              ref={collapse}
              label={translate(
                'components.orchestrationCrew.collapse',
                'Collapse orchestration panel'
              )}
              onClick={() => changeOpen(false)}
            >
              <PanelRightClose />
            </IconButton>
          </div>
          <div className="scrollbar-sleek min-h-0 flex-1 overflow-y-auto pb-2">
            {sections.map(([key, sectionTitle, rows]) =>
              rows.length > 0 ? (
                <section key={key} aria-label={sectionTitle}>
                  <div className="flex items-center gap-1.5 px-3 pb-1.5 pt-3 text-2xs font-semibold text-muted-foreground">
                    <span className="uppercase tracking-wider">{sectionTitle}</span>
                    <span className="tracking-wider">{rows.length}</span>
                    {key === 'Managing' ? (
                      <Button
                        variant="outline"
                        size="xs"
                        className="ml-auto h-5 px-2 text-2xs font-medium disabled:opacity-40"
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
                      look={lookByParty.get(row.partyKey)!}
                      target={target}
                      isVisible={isVisible}
                      canMention={canMention}
                      mention={mention}
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
              className="pointer-events-auto absolute top-[calc(var(--orca-pane-title-height)-var(--native-chat-header-inset,0px)+var(--spacing)*2)] right-0 h-auto max-w-full gap-1.5 py-1"
              aria-label={translate(
                'components.orchestrationCrew.show',
                'Show orchestration: {{counts}}',
                { counts: summary.counts }
              )}
              aria-expanded={false}
              onClick={() => changeOpen(true)}
            >
              <PanelRight />
              <span aria-hidden className="h-3.5 w-px shrink-0 bg-border" />
              <span aria-hidden className="inline-flex items-center gap-0.5 text-muted-foreground">
                <Workflow className="size-3" />
                {managing.length > 0 ? (
                  <span className="text-[11px] tabular-nums">{managing.length}</span>
                ) : null}
              </span>
              <span aria-hidden className="inline-flex min-w-0 items-center gap-1">
                {summary.groups.map(({ group, looks: members }) => (
                  <span
                    key={group}
                    data-crew-group={group}
                    className="inline-flex shrink-0 items-center gap-0.5"
                  >
                    <StatusIndicator status={members[0].status} showTooltip={false} />
                    <CrewAgentStack looks={members} />
                  </span>
                ))}
              </span>
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>
            {translate('components.orchestrationCrew.summary', 'Orchestration: {{counts}}', {
              counts: summary.counts
            })}
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  )
}

// Memoized so one agent's status change re-renders only that row.
const CrewRowView = memo(function CrewRowView({
  row,
  look,
  target,
  isVisible,
  canMention,
  mention: mentionRows
}: {
  row: OrchestrationCrewRow
  look: CrewRowLook
  target: RuntimeClientTarget
  isVisible: boolean
  canMention: boolean
  mention: (rows: OrchestrationCrewRow[]) => void
}) {
  // A pending question already shows on the row's second line, so rows start collapsed.
  const [expanded, setExpanded] = useState(false)
  const open = () => {
    void openOrchestrationCrewAgent(row, target)
  }
  const toggle = () => setExpanded((value) => !value)
  const mention = () => mentionRows([row])
  return (
    <div className="mx-2 mb-1 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-0.5 rounded-lg border border-transparent px-2.5 py-2 hover:border-border/70 hover:bg-accent/50">
      <button
        type="button"
        className="row-span-2 grid min-w-0 cursor-pointer grid-cols-[auto_minmax(0,1fr)] items-center gap-x-2 gap-y-0.5 rounded-md text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-default"
        disabled={!canMention || !row.sendAddress}
        // Keep focus in the terminal or composer the mention lands in.
        onPointerDown={(event) => event.preventDefault()}
        onClick={mention}
      >
        <CrewAgentIcons look={look} hostLabel={row.hostLabel} />
        <span className="truncate text-[13px] font-medium">{row.task?.title ?? row.label}</span>
        <span
          className={cn(
            'col-start-2 truncate text-xs',
            row.pendingQuestion ? 'text-status-warning' : 'text-muted-foreground'
          )}
        >
          {row.pendingQuestion
            ? `${translate('components.orchestrationCrew.waitingPrefix', 'Waiting for you · ')}${row.pendingQuestion.preview}`
            : (row.latest?.preview ?? row.progress ?? '')}
        </span>
      </button>
      <div className="flex shrink-0 items-center">
        <IconButton
          label={translate(
            'components.orchestrationCrew.showDetails',
            "Show {{name}}'s task and latest message",
            { name: row.label }
          )}
          aria-expanded={expanded}
          onClick={toggle}
        >
          {expanded ? <ChevronDown /> : <ChevronRight />}
        </IconButton>
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
      </div>
      <Time className="justify-self-end pr-1" at={row.pendingQuestion?.at ?? row.latest?.at} />
      {!row.sendAddress ? (
        <p className="col-span-2 pt-1 text-xs text-muted-foreground">
          {translate('components.orchestrationCrew.sendingUnavailable', 'Sending unavailable')}
        </p>
      ) : null}
      {expanded ? (
        <div className="col-span-2 pt-2">
          <CrewRowDetails row={row} />
        </div>
      ) : null}
    </div>
  )
})
