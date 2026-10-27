import { getProjectHostSetupProjectionFromState } from '@/store/project-host-setup-selector'
import {
  getProjectHostSetupLookup,
  type WorkspaceProjectOwner
} from '../../../shared/project-host-setup-lookup'
import type { HttpLinkSourceOwner, HttpLinkStoreState } from './http-link-routing'
import {
  parseLoopbackUrlWithPort,
  type LocalhostWorktreeLabelRoute
} from '../../../shared/localhost-worktree-labels'
import type { WorkspacePort, WorkspacePortScanResult } from '../../../shared/workspace-ports'

export type LocalhostLinkRepo = {
  id: string
  displayName: string
}

export type LocalhostLinkProject = LocalhostLinkRepo

export type LocalhostLinkWorktree = { id: string } & Partial<WorkspaceProjectOwner>

export function localhostLabelRouteForHttpLink(
  url: string,
  state: HttpLinkStoreState,
  sourceOwner?: HttpLinkSourceOwner
): LocalhostWorktreeLabelRoute | null {
  if (sourceOwner && sourceOwner.kind !== 'local') {
    return null
  }
  const sourceScan =
    sourceOwner?.kind === 'local'
      ? (state.workspacePortScansByKey?.['local:all'] ?? null)
      : undefined
  return localhostLabelRouteForTerminalLink(url, state, sourceOwner?.kind === 'local', sourceScan)
}

export async function openLabeledLocalhostLink(
  fallbackUrl: string,
  route: LocalhostWorktreeLabelRoute,
  open: (url: string) => void
): Promise<void> {
  try {
    const result = await window.api.localhostWorktreeLabels.register(route)
    open(result.url)
  } catch {
    open(fallbackUrl)
  }
}

function localhostLabelRouteForTerminalLink(
  rawUrl: string,
  state: HttpLinkStoreState,
  ignoreActiveRuntime = false,
  sourceScan?: WorkspacePortScanResult | null
): LocalhostWorktreeLabelRoute | null {
  if (
    state.settings?.localhostWorktreeLabelsEnabled !== true ||
    (!ignoreActiveRuntime && state.settings?.activeRuntimeEnvironmentId?.trim())
  ) {
    return null
  }
  // Why: only loopback links we can attribute to a scanned workspace port
  // should get a worktree label; everything else must stay as-is.
  const parsed = parseLoopbackUrlWithPort(rawUrl)
  if (!parsed) {
    return null
  }
  const scan = sourceScan === undefined ? state.workspacePortScan?.result : sourceScan
  const port = findWorkspacePortByNumber(scan, Number(parsed.port))
  if (!port) {
    return null
  }
  const repo = state.repos?.find((entry) => entry.id === port.owner.repoId) ?? null
  if (!repo) {
    return null
  }
  const worktree = findWorktreeById(state, port.owner.worktreeId)
  const projection = getProjectHostSetupProjectionFromState(state)
  const projectId = getProjectHostSetupLookup(projection.setups).projectId({
    ...worktree,
    repoId: port.owner.repoId
  })
  const project = projectId
    ? (projection.projects.find((entry) => entry.id === projectId) ?? null)
    : null
  const projectSource = project ?? repo
  return {
    targetUrl: parsed.toString(),
    projectName: projectSource.displayName,
    worktreeName: port.owner.displayName,
    worktreePath: port.owner.path,
    repoId: repo.id,
    worktreeId: port.owner.worktreeId
  }
}

function findWorkspacePortByNumber(
  scan: WorkspacePortScanResult | null | undefined,
  portNumber: number
): (WorkspacePort & { kind: 'workspace' }) | null {
  const port =
    scan?.ports.find(
      (candidate): candidate is WorkspacePort & { kind: 'workspace' } =>
        candidate.kind === 'workspace' && candidate.port === portNumber
    ) ?? null
  return port
}

function findWorktreeById(
  state: HttpLinkStoreState,
  worktreeId: string
): LocalhostLinkWorktree | null {
  const fromAllWorktrees = state.allWorktrees?.().find((worktree) => worktree.id === worktreeId)
  if (fromAllWorktrees) {
    return fromAllWorktrees
  }
  const worktreesByRepo = state.worktreesByRepo ?? {}
  for (const worktrees of Object.values(worktreesByRepo)) {
    const worktree = worktrees.find((entry) => entry.id === worktreeId)
    if (worktree) {
      return worktree
    }
  }
  return null
}
