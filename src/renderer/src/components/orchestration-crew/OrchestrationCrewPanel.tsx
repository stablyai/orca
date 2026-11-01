import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { PanelRight, PanelRightClose, Workflow } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import StatusIndicator from '@/components/sidebar/StatusIndicator'
import { formatStateCount } from '@/components/sidebar/worktree-card-agent-summary'
import type { WorktreeStatus } from '@/lib/worktree-status'
import type {
  OrchestrationCrewRow,
  OrchestrationCrewSnapshot
} from '../../../../shared/orchestration-crew'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { useOrchestrationCrew } from '../native-chat/use-orchestration-crew'
import { translate } from '@/i18n/i18n'
import { hasVisibleOverlay } from '@/lib/visible-overlay'
import { isImeOwnedKeyboardEvent } from '@/lib/ime-composition-keyboard-event'
import { CrewRowView, IconButton } from './CrewRowView'
import {
  CREW_STATUS_GROUPS,
  CrewAgentStack,
  crewStatusGroup,
  useCrewRowLooks,
  type CrewRowLook,
  type CrewStatusGroup
} from './CrewAgentIcons'

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

// One fixed sidebar icon per group, so a group's icon never changes with message order.
const GROUP_STATUS = {
  needsYou: 'permission',
  working: 'working',
  idle: 'inactive',
  failed: 'failed'
} as const satisfies Record<CrewStatusGroup, WorktreeStatus>

function groupCount(group: CrewStatusGroup, count: number): string {
  // The sidebar's "needs attention" count is singular in every form, so this one is the panel's own.
  return group === 'needsYou'
    ? translate('components.orchestrationCrew.needsYou', '{{count}} need you', {
        count,
        defaultValue_one: '{{count}} needs you'
      })
    : formatStateCount(group, count)
}

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
    ...groups.map(({ group, looks: members }) => groupCount(group, members.length))
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
  // Hosts pass a new mention function each render; rows get one stable function so their memo holds.
  const latestMention = useRef(mention)
  useLayoutEffect(() => {
    latestMention.current = mention
  })
  const stableMention = useCallback(
    (rows: OrchestrationCrewRow[]) => latestMention.current(rows),
    []
  )
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
      // z-15: above terminal text and the chat rail, below the pane title strip (z-20) so its buttons stay usable.
      className="pointer-events-none absolute bottom-0 top-0 right-0 z-[15] w-80 max-w-full text-foreground"
      onMouseDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation()
      }}
    >
      {open ? (
        <aside
          aria-label={title}
          // The pane's title strip draws its buttons over this band, so no chat or terminal text shows above the panel.
          className="pointer-events-auto flex h-full w-full flex-col border-l border-border bg-card pt-(--orca-pane-title-height) text-card-foreground shadow-xs"
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
                      mention={stableMention}
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
              className="pointer-events-auto absolute top-[calc(var(--orca-pane-title-height)+var(--spacing)*2)] right-0 h-auto max-w-full gap-1.5 py-1"
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
                    <StatusIndicator status={GROUP_STATUS[group]} showTooltip={false} />
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
