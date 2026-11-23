import { defineFixture } from '../../component-fixtures/component-fixture'
import { stubBots } from '../../component-fixtures/fixture-bots'
import { fixtureCos } from '../../component-fixtures/fixture-bot-panel'
import { makeFolderWorkspace } from '@/store/folder-workspaces/folder-workspace.test-fixture'
import { createCompatibleRuntimeStatusResponse } from '@/runtime/rpc/testing/runtime-compatibility-test-fixture'
import type { Bot } from '../../../../shared/bot-types'
import type { ExecutionHostId } from '../../../../shared/execution-host/execution-host'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/remote-runtime/host-catalog/runtime-environments'
import type { BotGroup } from '../../../../shared/bots/bot-group'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host/execution-host'
import { setBotHostListing, stampBotHost } from '@/lib/bot-catalog-snapshot'
import { publishBotGroups, readBotGroups } from '@/lib/bot-group-catalog-snapshot'
import { ConfirmationDialogProvider } from '../dismiss/confirmation/confirmation-dialog'
import { BotGroupPanelHeader } from './BotGroupPanelHeader'
import { BotPanelHeader, type BotQuietFacts } from './BotPanelHeader'
import { ListFilter } from 'lucide-react'
import { Button } from '@/components/ui/button'

// A bot's panel header on this computer and on paired servers, at the panel's widths.
const now = Date.now()
const M4: ExecutionHostId = 'runtime:m4'
const LONG: ExecutionHostId = 'runtime:long'
const LONG_2: ExecutionHostId = 'runtime:long2'

function environment(id: string, name: string): PublicKnownRuntimeEnvironment {
  return {
    id,
    name,
    createdAt: 1,
    updatedAt: 1,
    lastUsedAt: null,
    runtimeId: null,
    endpoints: [],
    preferredEndpointId: id
  }
}

const on = (hostId: ExecutionHostId, extra: Partial<Bot> = {}): Bot =>
  stampBotHost(hostId, { ...fixtureCos, name: 'Marketing - X-Manager', ...extra })

const NEXT: BotQuietFacts = {
  running: null,
  next: { name: 'Look around', at: now + 2 * 3_600_000 }
}
const RUNNING: BotQuietFacts = { running: 'Mentions triage', next: null }
const NOTHING: BotQuietFacts = { running: null, next: null }
const noPicture: Parameters<typeof BotPanelHeader>[0]['picture'] = {
  value: { kind: 'mascot', index: 0 },
  custom: null,
  pick: () => {},
  upload: () => {},
  undo: () => {},
  color: null,
  pickColor: () => {},
  outfit: null,
  pickOutfit: () => {}
}

type Row = {
  label: string
  bot: Bot
  quiet?: BotQuietFacts
  counts?: { needsYou: number; working: number }
  offline?: boolean
  /** The Items filter the real header shows once the bot has items. */
  filter?: boolean
}

/** The Activity panel's own box: its left border, then the scroll area's `@container` and padding. */
function PanelFrame({ width, children }: { width: number; children: React.ReactNode }) {
  return (
    <div className="flex flex-col border-l border-border bg-sidebar" style={{ width }}>
      <div className="@container flex flex-col px-2 py-3">{children}</div>
    </div>
  )
}

const filterButton = (
  <Button variant="ghost" size="icon-sm" aria-label="Filter">
    <ListFilter />
  </Button>
)

function scene(width: number, rows: Row[], groups = false) {
  const hosts = [...new Set(rows.map((row) => row.bot.hostId))]
  return defineFixture({
    width: width + 24,
    store: {
      runtimeEnvironments: [
        environment('m4', 'm4 air'),
        environment('m4down', 'm4 air'),
        environment('long', 'build-server-linux-eu-west-2'),
        environment('long2', 'build-server-linux-eu-west-1')
      ],
      runtimeStatusByEnvironmentId: new Map(
        ['m4', 'long', 'long2'].map((id) => [
          id,
          { status: createCompatibleRuntimeStatusResponse(id).result, checkedAt: 1 }
        ])
      ),
      folderWorkspaces: hosts.map((hostId) =>
        makeFolderWorkspace({
          id: fixtureCos.folderWorkspaceId,
          name: fixtureCos.name,
          folderPath: `~/.orca/bots/${fixtureCos.folder}`,
          executionHostId: hostId
        })
      )
    },
    setup: () => {
      stubBots([fixtureCos])
      stampCrew()
    },
    render: () => (
      <div className="flex flex-col gap-2 bg-background p-3">
        {groups ? groupRows(width) : null}
        {rows.map((row) => (
          <div key={row.label} className="flex flex-col gap-1">
            <div className="text-[11px] text-muted-foreground">{row.label}</div>
            <PanelFrame width={width}>
              <BotPanelHeader
                bot={row.bot}
                now={row.counts ?? { needsYou: 0, working: 0 }}
                quiet={row.quiet ?? NEXT}
                picture={noPicture}
                offline={row.offline}
                filter={row.filter ? filterButton : null}
              />
            </PanelFrame>
          </div>
        ))}
      </div>
    )
  })
}

const STATES = (width: number): Row[] => [
  { label: `${width} px · this computer (unchanged)`, bot: on('local') },
  { label: `${width} px · m4 air, idle`, bot: on(M4) },
  {
    label: `${width} px · m4 air, running`,
    bot: on(M4),
    quiet: RUNNING,
    counts: { needsYou: 0, working: 1 }
  },
  { label: `${width} px · m4 air, needs you`, bot: on(M4), counts: { needsYou: 2, working: 0 } },
  { label: `${width} px · m4 air, no schedule`, bot: on(M4), quiet: NOTHING },
  { label: `${width} px · m4 air, paused`, bot: on(M4, { paused: true }) },
  { label: `${width} px · m4 air, disconnected`, bot: on(M4), offline: true },
  { label: `${width} px · long host`, bot: on(LONG) },
  { label: `${width} px · long host, shared prefix`, bot: on(LONG_2) }
]

export const wide = scene(440, STATES(440))
export const normal = scene(340, STATES(340))
export const narrow = scene(260, STATES(260))
const PANEL = (width: number): Row[] => [
  { label: `${width} px · this computer, items filter`, bot: on('local'), filter: true },
  { label: `${width} px · m4 air, idle`, bot: on(M4) },
  { label: `${width} px · m4 air, idle, items filter`, bot: on(M4), filter: true },
  { label: `${width} px · long host, items filter`, bot: on(LONG), filter: true },
  {
    label: `${width} px · m4 air, home not read yet`,
    bot: on(M4, { folderWorkspaceId: 'fw-none' })
  }
]

/** The real panel's width budget, with and without the Items filter. */
export const panel340 = scene(340, PANEL(340))
export const panel300 = scene(300, PANEL(300))
export const groupWide = scene(440, [], true)
export const groupNormal = scene(340, [], true)
export const groupNarrow = scene(260, [], true)

const CREW: BotGroup = {
  id: 'g-crew',
  name: 'Release crew',
  hostId: LOCAL_EXECUTION_HOST_ID,
  revision: 1,
  folder: 'group-crew',
  folderWorkspaceId: 'fw-crew',
  createdAt: 1,
  replyMode: { kind: 'mentions' },
  members: [{ botId: fixtureCos.id, sessionId: 's-1' }]
}

const M4_DOWN: ExecutionHostId = 'runtime:m4down'
const stampedCrews = new Map<ExecutionHostId, BotGroup>()

/** The crew as each server's listing stamps it; the listing then keeps only the down server, so nothing reads one. */
function stampCrew(): void {
  setBotHostListing({
    hosts: [
      { hostId: LOCAL_EXECUTION_HOST_ID, state: 'live' },
      { hostId: M4, state: 'live' },
      { hostId: M4_DOWN, state: 'live' }
    ],
    updateNeeded: []
  })
  for (const hostId of [M4, M4_DOWN]) {
    publishBotGroups([CREW], hostId)
    const stamped = readBotGroups().find((group) => group.hostId === hostId)
    if (stamped) {
      stampedCrews.set(hostId, stamped)
    }
  }
  setBotHostListing({
    hosts: [
      { hostId: LOCAL_EXECUTION_HOST_ID, state: 'live' },
      { hostId: M4_DOWN, state: 'offline' }
    ],
    updateNeeded: []
  })
}

const crew = (hostId: ExecutionHostId): BotGroup => stampedCrews.get(hostId) ?? CREW

function groupRows(width: number): React.JSX.Element {
  const groups: { label: string; group: BotGroup; members: Bot[]; working: number }[] = [
    {
      label: 'group · this computer (unchanged)',
      group: crew('local'),
      members: [on('local')],
      working: 0
    },
    { label: 'group · m4 air, idle', group: crew(M4), members: [on(M4)], working: 0 },
    { label: 'group · m4 air, working', group: crew(M4), members: [on(M4)], working: 2 },
    {
      label: 'group · m4 air, disconnected',
      group: crew(M4_DOWN),
      members: [on(M4_DOWN)],
      working: 0
    },
    {
      label: 'group · m4 air, disconnected, no members',
      group: crew(M4_DOWN),
      members: [],
      working: 0
    }
  ]
  return (
    <ConfirmationDialogProvider>
      {groups.map((row) => (
        <div key={row.label} className="flex flex-col gap-1">
          <div className="text-[11px] text-muted-foreground">{`${width} px · ${row.label}`}</div>
          <PanelFrame width={width}>
            <BotGroupPanelHeader
              group={row.group}
              members={row.members}
              needsYou={0}
              working={row.working}
              next={{ bot: on(row.group.hostId), at: now + 2 * 3_600_000 }}
              now={now}
              filter={null}
            />
          </PanelFrame>
        </div>
      ))}
    </ConfirmationDialogProvider>
  )
}
