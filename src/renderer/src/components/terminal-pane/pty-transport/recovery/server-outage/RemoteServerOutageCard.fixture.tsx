import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { defineFixture } from '../../../../../component-fixtures/component-fixture'
import type { PublicKnownRuntimeEnvironment } from '../../../../../../../shared/remote-runtime/host-catalog/runtime-environments'
import { cn } from '@/lib/class-names'
import { RemoteServerOutageCardLine } from './RemoteServerOutageCard'
import { RemoteServerOutageCardStack, RemoteServerOutageCards } from './RemoteServerOutageCards'
import { RemoteServerPaneVeil } from './RemoteServerPaneVeil'
import {
  useRemoteServerNoticeClaim,
  useReportRemoteServerPaneRetries
} from './remote-server-notice-claims'
import { usePublishRemoteServerDownTab, useTabHasDownServer } from './remote-server-outage-signals'

const DEVBOX = 'env-devbox-1'
const BUILDBOX = 'env-buildbox'

function server(id: string, name: string, endpoint: string): PublicKnownRuntimeEnvironment {
  return {
    id,
    name,
    createdAt: 1,
    updatedAt: 1,
    lastUsedAt: null,
    runtimeId: null,
    endpoints: [{ id: 'ws', kind: 'websocket', label: 'WebSocket', endpoint }],
    preferredEndpointId: 'ws'
  }
}

const STORE = {
  runtimeEnvironments: [
    server(DEVBOX, 'devbox-1', 'ws://100.64.0.10:6768'),
    server(BUILDBOX, 'buildbox-west-long-hostname', 'ws://buildbox.internal:6768')
  ]
}

const SCROLLBACK = Array.from({ length: 120 }, (_, index) =>
  index % 4 === 0
    ? `$ pnpm test --filter app (${index})`
    : `[12:${String(index % 60).padStart(2, '0')}] tool call: read_file src/app-${index}.ts`
).join('\r\n')

function FixtureTerminal({
  onTerminal,
  mouseTracking
}: {
  onTerminal: (terminal: Terminal) => void
  mouseTracking: boolean
}): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const host = hostRef.current
    if (!host) {
      return
    }
    const foreground = getComputedStyle(host).getPropertyValue('color')
    const terminal = new Terminal({
      fontSize: 11,
      rows: 14,
      cols: 60,
      scrollback: 500,
      allowTransparency: true,
      theme: { background: '#00000000', foreground }
    })
    terminal.open(host)
    terminal.write(SCROLLBACK)
    if (mouseTracking) {
      // Like tmux or vim with the mouse on: a wheel here would become input for the program.
      terminal.write('\x1b[?1000h\x1b[?1006h')
    }
    const input = terminal.onData((data) => {
      const fixtureWindow: Window & { fixturePaneInput?: string } = window
      fixtureWindow.fixturePaneInput = (fixtureWindow.fixturePaneInput ?? '') + data
    })
    onTerminal(terminal)
    return () => {
      input.dispose()
      terminal.dispose()
    }
  }, [mouseTracking, onTerminal])
  return (
    <div ref={hostRef} className="absolute inset-0 overflow-hidden px-2 pt-1 text-foreground" />
  )
}

type PaneSpec = { environmentId: string | null; id: string; mouseTracking?: boolean }
type GroupSpec = { id: string; tabs: { title: string; down: boolean }[]; panes: PaneSpec[] }

function FixturePane({ pane, veiled }: { pane: PaneSpec; veiled: boolean }): React.JSX.Element {
  const [terminal, setTerminal] = useState<Terminal | null>(null)
  return (
    <div
      className="relative min-w-0 flex-1 border-r border-border bg-background last:border-r-0"
      data-fixture-pane={pane.id}
    >
      <FixtureTerminal onTerminal={setTerminal} mouseTracking={pane.mouseTracking ?? false} />
      {veiled && terminal && pane.environmentId ? (
        <RemoteServerPaneVeil environmentId={pane.environmentId} terminal={terminal} />
      ) : null}
    </div>
  )
}

function FixtureTab({ title, down }: { title: string; down: boolean }): React.JSX.Element {
  return (
    <div className="flex h-full items-center px-2 text-xs text-foreground">
      {down ? (
        <span
          aria-hidden
          data-tab-server-down=""
          className="mr-1 size-1.5 shrink-0 rounded-full bg-status-warning"
        />
      ) : null}
      <span className="truncate">{title}</span>
    </div>
  )
}

function FixtureGroup({
  group,
  veiledServers
}: {
  group: GroupSpec
  veiledServers: ReadonlySet<string>
}): React.JSX.Element {
  return (
    <div className="flex min-w-0 flex-1 flex-col border-r border-border last:border-r-0">
      <div className="flex h-8 shrink-0 items-stretch border-b border-border bg-sidebar">
        {group.tabs.map((tab) => (
          <FixtureTab key={tab.title} title={tab.title} down={tab.down} />
        ))}
      </div>
      <div className="flex min-h-0 flex-1">
        {group.panes.map((pane) => (
          <FixturePane
            key={pane.id}
            pane={pane}
            veiled={pane.environmentId !== null && veiledServers.has(pane.environmentId)}
          />
        ))}
      </div>
    </div>
  )
}

function FixtureWindow({
  groups,
  veiledServers,
  cards,
  width
}: {
  groups: GroupSpec[]
  veiledServers: ReadonlySet<string>
  cards: React.ReactNode
  width: number
}): React.JSX.Element {
  return (
    <div
      className="flex h-[360px] overflow-hidden rounded-md border border-border bg-background"
      style={{ width }}
    >
      <div className="relative flex min-w-0 flex-1" data-fixture-workspace="">
        {groups.map((group) => (
          <FixtureGroup key={group.id} group={group} veiledServers={veiledServers} />
        ))}
        {cards}
      </div>
      {width > 500 ? (
        <div className="w-[150px] shrink-0 border-l border-border bg-sidebar p-2 text-xs text-muted-foreground">
          Activity
        </div>
      ) : null}
    </div>
  )
}

const MINUTES_25 = 25 * 60_000
const ONE_PANE: GroupSpec[] = [
  { id: 'dev', tabs: [{ title: 'dev', down: true }], panes: [{ environmentId: DEVBOX, id: 'a' }] }
]
const SPLIT: GroupSpec[] = [
  {
    id: 'dev',
    tabs: [
      { title: 'dev', down: true },
      { title: 'zsh', down: false }
    ],
    panes: [{ environmentId: DEVBOX, id: 'a' }]
  },
  {
    id: 'agent',
    tabs: [
      { title: 'agent', down: true },
      { title: 'zsh', down: false }
    ],
    panes: [
      { environmentId: DEVBOX, id: 'b' },
      { environmentId: DEVBOX, id: 'c', mouseTracking: true }
    ]
  }
]

function staticFixture({
  groups,
  servers,
  stopped = false,
  width = 900,
  openDetails = false
}: {
  groups: GroupSpec[]
  servers: string[]
  stopped?: boolean
  width?: number
  openDetails?: boolean
}) {
  return defineFixture({
    width,
    store: STORE,
    render: () => (
      <FixtureWindow
        groups={groups}
        width={width}
        veiledServers={new Set(servers)}
        cards={
          <RemoteServerOutageCardStack>
            {servers.map((environmentId) => (
              <RemoteServerOutageCardLine
                key={environmentId}
                environmentId={environmentId}
                downSince={Date.now() - MINUTES_25}
                stopped={stopped}
              />
            ))}
          </RemoteServerOutageCardStack>
        }
      />
    ),
    interact: openDetails
      ? async (frame) => {
          frame.querySelector<HTMLButtonElement>('[data-remote-server-outage-details]')?.click()
          await new Promise((resolve) => setTimeout(resolve, 200))
        }
      : undefined
  })
}

export const onePaneRetrying = staticFixture({ groups: ONE_PANE, servers: [DEVBOX] })
export const splitRetrying = staticFixture({ groups: SPLIT, servers: [DEVBOX] })
export const splitStopped = staticFixture({ groups: SPLIT, servers: [DEVBOX], stopped: true })
export const detailsOpen = staticFixture({ groups: SPLIT, servers: [DEVBOX], openDetails: true })
const NARROW: GroupSpec[] = [
  {
    id: 'build',
    tabs: [{ title: 'build', down: true }],
    panes: [{ environmentId: BUILDBOX, id: 'a' }]
  }
]
export const narrowRetrying = staticFixture({
  groups: NARROW,
  servers: [BUILDBOX],
  width: 320
})
export const narrowWindow = staticFixture({
  groups: NARROW,
  servers: [BUILDBOX],
  stopped: true,
  width: 320
})
export const twoServersDown = staticFixture({
  groups: [
    SPLIT[0],
    {
      id: 'build',
      tabs: [{ title: 'build', down: true }],
      panes: [{ environmentId: BUILDBOX, id: 'd' }]
    }
  ],
  servers: [DEVBOX, BUILDBOX]
})

/** One tab's surface: claims the outage like a terminal tab does, and veils its panes once the card shows. */
function LiveSurface({
  group,
  environmentId,
  down,
  stopped,
  visible,
  tabId
}: {
  group: GroupSpec
  environmentId: string
  down: boolean
  stopped: boolean
  visible: boolean
  tabId: string
}): React.JSX.Element {
  const notice = useRemoteServerNoticeClaim(environmentId, down, visible)
  useReportRemoteServerPaneRetries(environmentId, down ? (stopped ? 'latched' : 'retrying') : null)
  const veiled = down && notice.showing
  usePublishRemoteServerDownTab(tabId, down)
  const tabDown = useTabHasDownServer(tabId)
  return (
    <FixtureGroup
      group={{
        ...group,
        tabs: group.tabs.map((tab, index) => ({ ...tab, down: index === 0 && tabDown }))
      }}
      veiledServers={veiled ? new Set([environmentId]) : new Set()}
    />
  )
}

function LiveWorkbench(): React.JSX.Element {
  const [down, setDown] = useState(true)
  const [stopped, setStopped] = useState(false)
  const [away, setAway] = useState(false)
  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-2 text-xs">
        <button type="button" data-fixture-toggle-down="" onClick={() => setDown((v) => !v)}>
          {down ? 'Bring server back' : 'Drop server'}
        </button>
        <button type="button" data-fixture-toggle-stopped="" onClick={() => setStopped((v) => !v)}>
          {stopped ? 'Resume retries' : 'Stop retries'}
        </button>
        <button type="button" data-fixture-toggle-away="" onClick={() => setAway((v) => !v)}>
          {away ? 'Back to devbox-1 work' : 'Switch to local work'}
        </button>
      </div>
      <div
        className={cn('relative flex h-[360px] w-[900px] overflow-hidden rounded-md border')}
        data-fixture-workspace=""
      >
        {SPLIT.map((group) => (
          <LiveSurface
            key={group.id}
            group={group}
            environmentId={DEVBOX}
            down={down}
            stopped={stopped}
            visible={!away}
            tabId={group.id}
          />
        ))}
        <RemoteServerOutageCards />
      </div>
    </div>
  )
}

/** The real registry, reveal clock, card, veil and nudge; the card appears after the 5s reveal delay. */
export const liveOutage = defineFixture({
  width: 920,
  store: STORE,
  setup: () => {
    const fixtureWindow = Object.assign(window, { fixtureReconnects: 0 })
    window.api.runtimeEnvironments.retryConnectionsNow = async () => {
      fixtureWindow.fixtureReconnects += 1
    }
  },
  render: () => <LiveWorkbench />
})
