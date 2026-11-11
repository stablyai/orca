import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { PanelRight, PanelRightClose, Workflow } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/class-names'
import StatusIndicator from '@/components/sidebar/workspace-card/surface/StatusIndicator'
import { formatStateCount } from '@/components/sidebar/workspace-card/activity/worktree-card-agent-summary'
import type { WorktreeStatus } from '../../../../shared/worktree-status-rollup'
import type {
  OrchestrationCrewRow,
  OrchestrationCrewSnapshot
} from '../../../../shared/orchestration/orchestration-crew'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { useOrchestrationCrew } from './use-orchestration-crew'
import { translate } from '@/i18n/i18n'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { hasVisibleOverlay } from '@/lib/visible-overlay'
import { isImeOwnedKeyboardEvent } from '@/lib/text-input/ime/ime-composition-keyboard-event'
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
  /** A chat's host frame already ends above its composer; a terminal keeps the CLI's prompt and recent output clear. */
  surface?: 'chat' | 'terminal'
}

// One fixed sidebar icon per group, so a group's icon never changes with message order.
const GROUP_STATUS = {
  needsYou: 'permission',
  working: 'working',
  idle: 'inactive',
  failed: 'failed'
} as const satisfies Record<CrewStatusGroup, WorktreeStatus>

function groupCount(group: CrewStatusGroup, count: number, t: Translate = translate): string {
  // The sidebar's "needs attention" count is singular in every form, so this one is the panel's own.
  return group === 'needsYou'
    ? t('components.orchestrationCrew.needsYou', '{{count}} need you', {
        count,
        defaultValue_one: '{{count}} needs you'
      })
    : formatStateCount(group, count, t)
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

function disclosureKey(section: string, party: string): string {
  return JSON.stringify([section, party])
}

function crewTabSummary(
  workers: number,
  looks: readonly CrewRowLook[],
  t: Translate = translate
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
          t('components.orchestrationCrew.workers', '{{count}} workers', {
            count: workers,
            defaultValue_one: '{{count}} worker'
          })
        ]
      : []),
    ...groups.map(({ group, looks: members }) => groupCount(group, members.length, t))
  ].join(', ')
  return { groups, counts }
}

export function OrchestrationCrewPanel(props: PanelProps): React.JSX.Element | null {
  const snapshot = useOrchestrationCrew(
    props.target,
    props.isVisible === false ? null : props.party
  )
  return <CrewPanelContent {...props} snapshot={snapshot} />
}

export function CrewPanelContent({
  target,
  party,
  canMention,
  mention,
  snapshot,
  isVisible = true,
  surface = 'chat'
}: PanelProps & { snapshot: OrchestrationCrewSnapshot }): React.JSX.Element | null {
  const t = useTranslate()
  const [open, setOpen] = useState(false)
  const scope = JSON.stringify([
    target.kind,
    target.kind === 'environment' ? target.environmentId : null,
    party
  ])
  const [disclosures, setDisclosures] = useState(() => ({ scope, keys: new Set<string>() }))
  const toggleDisclosure = useCallback(
    (key: string) => {
      setDisclosures((previous) => {
        const keys = new Set(previous.scope === scope ? previous.keys : [])
        if (keys.has(key)) {
          keys.delete(key)
        } else {
          keys.add(key)
        }
        return { scope, keys }
      })
    },
    [scope]
  )
  const root = useRef<HTMLDivElement>(null)
  const tab = useRef<HTMLButtonElement>(null)
  const collapse = useRef<HTMLButtonElement>(null)
  const restore = useRef(false)
  const closePanel = useCallback(() => {
    restore.current = true
    setOpen(false)
    setDisclosures({ scope, keys: new Set() })
  }, [scope])
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
  const currentDisclosureKeys = useMemo(
    () =>
      new Set([
        ...managedBy.map((row) => disclosureKey('Managed by', row.partyKey)),
        ...managing.map((row) => disclosureKey('Managing', row.partyKey)),
        ...talkingWith.map((row) => disclosureKey('Talking with', row.partyKey))
      ]),
    [managedBy, managing, talkingWith]
  )
  if (disclosures.scope !== scope) {
    setDisclosures({ scope, keys: new Set() })
  } else if (
    snapshot.status === 'ok' &&
    [...disclosures.keys].some((key) => !currentDisclosureKeys.has(key))
  ) {
    setDisclosures({
      scope,
      keys: new Set([...disclosures.keys].filter((key) => currentDisclosureKeys.has(key)))
    })
  }
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
      closePanel()
    }
    pane.addEventListener('keydown', onKeyDown, true)
    return () => pane.removeEventListener('keydown', onKeyDown, true)
  }, [open, visible, closePanel])
  if (!visible) {
    return null
  }
  const summary = crewTabSummary(managing.length, looks, t)
  const changeOpen = (value: boolean) => {
    if (!value) {
      closePanel()
      return
    }
    restore.current = true
    setOpen(true)
  }
  const sections = [
    ['Managed by', t('components.orchestrationCrew.managedBy', 'Managed by'), managedBy],
    ['Managing', t('components.orchestrationCrew.managing', 'Managing'), managing],
    ['Talking with', t('components.orchestrationCrew.talkingWith', 'Talking with'), talkingWith]
  ] as const
  const title = t('components.orchestrationCrew.title', 'Orchestration')
  return (
    <div
      ref={root}
      data-orchestration-crew
      data-pane-prevent-terminal-focus
      data-native-chat-typing-redirect-ignore="true"
      // z-15: above terminal text and the chat rail, below the pane title strip (z-20) so its buttons stay usable.
      className="pointer-events-none absolute inset-0 z-[15] text-foreground [--crew-border:color-mix(in_srgb,var(--foreground)_20%,var(--border))] [--crew-surface:color-mix(in_srgb,var(--foreground)_7%,var(--card))]"
      onMouseDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation()
      }}
    >
      {open ? (
        <aside
          aria-label={title}
          // A card in the closed tab's corner, as tall as its rows. Chats end it above the composer
          // (their frame stops there); terminals keep the bottom quarter, where the CLI's prompt sits.
          // The header (and its collapse button) always shows: in a pane too short for both, it wins.
          className={cn(
            'pointer-events-auto absolute right-2.5 top-[calc(var(--orca-pane-title-height)+var(--spacing)*2)] flex min-h-[calc(var(--spacing)*9+2px)] w-78 max-w-[calc(100%-var(--spacing)*5)] flex-col overflow-hidden rounded-[12px] border border-(--crew-border) bg-(--crew-surface) text-card-foreground shadow-floating',
            surface === 'terminal'
              ? 'max-h-[calc(75%-var(--orca-pane-title-height)-var(--spacing)*2)]'
              : 'max-h-[calc(100%-var(--orca-pane-title-height)-var(--spacing)*4)]'
          )}
        >
          {/* The collapse button keeps its room in the narrowest panes: the title truncates and the side padding shrinks first. */}
          <div className="flex h-9 shrink-0 items-center justify-between border-b border-border px-[clamp(0px,calc((100%-var(--spacing)*6)/2),calc(var(--spacing)*2))]">
            <span className="min-w-0 truncate text-xs font-medium">{title}</span>
            <IconButton
              ref={collapse}
              label={t('components.orchestrationCrew.collapse', 'Collapse orchestration panel')}
              onClick={() => changeOpen(false)}
            >
              <PanelRightClose />
            </IconButton>
          </div>
          <div className="scrollbar-sleek min-h-0 overflow-y-auto pb-2">
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
                        className="ml-auto h-5"
                        disabled={!canMention || !rows.some(runningWorker)}
                        onClick={() => mention(rows.filter(runningWorker))}
                      >
                        {t('components.orchestrationCrew.mentionAll', 'Mention all')}
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
                      disclosureKey={disclosureKey(key, row.partyKey)}
                      expanded={disclosures.keys.has(disclosureKey(key, row.partyKey))}
                      toggleDisclosure={toggleDisclosure}
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
              variant="orchestration-tab"
              size="xs"
              className="pointer-events-auto absolute top-[calc(var(--orca-pane-title-height)+var(--spacing)*2)] right-0 max-w-[min(20rem,100%)]"
              aria-label={t('components.orchestrationCrew.show', 'Show orchestration: {{counts}}', {
                counts: summary.counts
              })}
              aria-expanded={false}
              onClick={() => changeOpen(true)}
            >
              <PanelRight />
              <span aria-hidden className="mx-0.5 h-3.5 w-px shrink-0 bg-border" />
              <span aria-hidden className="inline-flex items-center gap-0.5 text-muted-foreground">
                <Workflow className="size-3" />
                {managing.length > 0 ? (
                  <span className="text-[11px] tabular-nums">{managing.length}</span>
                ) : null}
              </span>
              <span aria-hidden className="ml-0.5 inline-flex min-w-0 items-center gap-1">
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
            {t('components.orchestrationCrew.summary', 'Orchestration: {{counts}}', {
              counts: summary.counts
            })}
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  )
}
