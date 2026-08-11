import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, vi } from 'vitest'
import type {
  DashboardCard,
  DashboardSleepWorkspaceArgs,
  DashboardSpawnAgentArgs
} from '../../../../shared/dashboard-snapshot'
import type { TuiAgent } from '../../../../shared/types'
import { AgentMap } from './AgentMap'
import type { AgentMapState } from './agent-map-filter'

export const NOW = 2_000_000_000

export function card(overrides: Partial<DashboardCard> = {}): DashboardCard {
  return {
    paneKey: 'pane-1',
    ptyId: 'pty-1',
    agentType: 'codex',
    bucket: 'working',
    dotState: 'working',
    task: 'Build map',
    repoId: 'repo-1',
    worktreeId: 'worktree-1',
    tabId: 'tab-1',
    leafId: 'leaf-1',
    repoName: 'Orca',
    worktreeName: 'Agent map',
    conversationName: 'Agent alpha',
    startedAt: NOW - 10 * 60_000,
    finishedAt: null,
    stateChangedAt: NOW - 1_000,
    unseen: false,
    hostKind: 'local',
    workspaceKind: 'worktree',
    ...overrides
  }
}

export type RenderMapOptions = {
  onOpenTerminal?: (card: DashboardCard) => void
  selectedPaneKey?: string | null
  compact?: boolean
  workspaceContextMenusEnabled?: boolean
  enabledStates?: ReadonlySet<AgentMapState>
  showOrchestrationLinks?: boolean
  launchableAgentsByWorktreeId?: Record<string, TuiAgent[]>
  onSpawnAgent?: (args: DashboardSpawnAgentArgs) => void
  onSleepWorkspace?: (args: DashboardSleepWorkspaceArgs) => void
}

export function renderMap(
  cards: DashboardCard[],
  {
    onOpenTerminal = vi.fn(),
    selectedPaneKey = null,
    compact = false,
    workspaceContextMenusEnabled = false,
    enabledStates,
    showOrchestrationLinks,
    launchableAgentsByWorktreeId,
    onSpawnAgent,
    onSleepWorkspace
  }: RenderMapOptions = {}
): ReturnType<typeof render> {
  return render(
    <AgentMap
      cards={cards}
      now={NOW}
      onOpenTerminal={onOpenTerminal}
      selectedPaneKey={selectedPaneKey}
      compact={compact}
      workspaceContextMenusEnabled={workspaceContextMenusEnabled}
      enabledStates={enabledStates}
      showOrchestrationLinks={showOrchestrationLinks}
      launchableAgentsByWorktreeId={launchableAgentsByWorktreeId}
      onSpawnAgent={onSpawnAgent}
      onSleepWorkspace={onSleepWorkspace}
    />
  )
}

export type AgentMapTestEnvironment = {
  /** Exposed so tests can assert the canvas does not re-read layout when idle. */
  boundsSpy: ReturnType<typeof vi.spyOn>
}

const CANVAS_BOUNDS = {
  x: 0,
  y: 0,
  left: 0,
  top: 0,
  right: 400,
  bottom: 300,
  width: 400,
  height: 300,
  toJSON: () => ({})
}
const ZERO_BOUNDS = { ...CANVAS_BOUNDS, right: 0, bottom: 0, width: 0, height: 0 }

/** Gives the map a measurable canvas and a non-Mac platform, the way every map
 *  suite needs it. Call once per describe block. */
export function installAgentMapEnvironment(): AgentMapTestEnvironment {
  const environment = {} as AgentMapTestEnvironment
  const originalUserAgent = navigator.userAgent

  beforeEach(() => {
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'Linux' })
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
    )
    environment.boundsSpy = vi
      .spyOn(Element.prototype, 'getBoundingClientRect')
      .mockImplementation(function getBounds(this: Element) {
        return this.classList.contains('agent-map-canvas') || this instanceof SVGSVGElement
          ? CANVAS_BOUNDS
          : ZERO_BOUNDS
      })
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
    vi.unstubAllGlobals()
    environment.boundsSpy.mockRestore()
    Object.defineProperty(navigator, 'userAgent', {
      configurable: true,
      value: originalUserAgent
    })
  })

  return environment
}
