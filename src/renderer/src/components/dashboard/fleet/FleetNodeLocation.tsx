import { Folder, GitBranch } from 'lucide-react'
import type { DashboardCard } from '../../../../../shared/agent-status/presentation/dashboard-snapshot'
import { DashboardHostBadge } from '../board/DashboardHostBadge'
import { fleetHostKey, fleetProjectKey, type FleetProject } from './fleet-view-model'

export function FleetNodeLocation({
  card,
  project
}: {
  card: DashboardCard
  project: FleetProject
}): React.JSX.Element {
  const WorkspaceGlyph = card.workspaceKind === 'folder' ? Folder : GitBranch
  const crossProject = fleetProjectKey(card) !== project.key
  return (
    <>
      <WorkspaceGlyph className="size-3 shrink-0" aria-hidden />
      <span className="truncate">
        {crossProject ? `${card.repoName} / ${card.worktreeName}` : card.worktreeName}
      </span>
      {fleetHostKey(card) === fleetHostKey(project) ? null : (
        <DashboardHostBadge
          hostKind={card.hostKind}
          executionHostId={card.executionHostId}
          hostLabel={card.hostLabel}
        />
      )}
    </>
  )
}
