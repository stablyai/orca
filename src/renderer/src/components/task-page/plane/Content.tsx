import { useEffect, useState } from 'react'
import { ExternalLink, LoaderCircle, RefreshCw } from 'lucide-react'
import { PlaneIcon } from '@/components/icons/PlaneIcon'
import { PlaneConnectDialog } from '@/components/plane-connect-dialog'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import type { TaskPageComposerActionsModel } from '../../use-task-page-composer-actions'
import type { PlaneIssue } from '../../../../../shared/plane-types'
import { PlaneIssueRow } from './PlaneIssueRow'

export function TaskPagePlaneContent({
  model: _model
}: {
  model: TaskPageComposerActionsModel
}): React.JSX.Element | null {
  const planeStatus = useAppStore((s) => s.planeStatus)
  const planeStatusChecked = useAppStore((s) => s.planeStatusChecked)
  const planeProjects = useAppStore((s) => s.planeProjects)
  const planeIssues = useAppStore((s) => s.planeIssues)
  const planeLoading = useAppStore((s) => s.planeLoading)
  const checkPlaneConnection = useAppStore((s) => s.checkPlaneConnection)
  const selectPlaneWorkspace = useAppStore((s) => s.selectPlaneWorkspace)
  const fetchPlaneProjects = useAppStore((s) => s.fetchPlaneProjects)
  const fetchPlaneIssues = useAppStore((s) => s.fetchPlaneIssues)

  const [connectDialogOpen, setConnectDialogOpen] = useState(false)
  const [selectedProjectId, setSelectedProjectId] = useState<string>('all')

  useEffect(() => {
    if (!planeStatusChecked) {
      void checkPlaneConnection()
    }
  }, [planeStatusChecked, checkPlaneConnection])

  useEffect(() => {
    if (planeStatus.connected && planeStatus.activeWorkspaceSlug) {
      void fetchPlaneProjects(planeStatus.activeWorkspaceSlug)
    }
  }, [planeStatus.connected, planeStatus.activeWorkspaceSlug, fetchPlaneProjects])

  useEffect(() => {
    if (planeStatus.connected && planeStatus.activeWorkspaceSlug) {
      void fetchPlaneIssues({
        workspaceSlug: planeStatus.activeWorkspaceSlug,
        projectId: selectedProjectId === 'all' ? undefined : selectedProjectId
      })
    }
  }, [planeStatus.connected, planeStatus.activeWorkspaceSlug, selectedProjectId, fetchPlaneIssues])

  if (!planeStatusChecked) {
    return (
      <div className="mt-4 flex items-center justify-center py-14">
        <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (!planeStatus.connected) {
    return (
      <div className="mt-4 flex flex-col items-center justify-center rounded-md border border-border/50 bg-muted/50 px-6 py-14 text-center shadow-sm">
        <PlaneIcon className="mb-4 size-10 text-muted-foreground/60" />
        <p className="text-base font-medium text-foreground">
          {translate(
            'auto.components.task.page.plane.connectTitle',
            'Connect your Plane workspace'
          )}
        </p>
        <p className="mt-2 max-w-sm text-sm text-muted-foreground">
          {translate(
            'auto.components.task.page.plane.connectDescription',
            'Browse, track, and start work from Plane issues directly in isolated worktrees.'
          )}
        </p>
        <Button type="button" size="sm" className="mt-6" onClick={() => setConnectDialogOpen(true)}>
          {translate('auto.components.task.page.plane.connectButton', 'Connect Plane')}
        </Button>
        <PlaneConnectDialog
          open={connectDialogOpen}
          onOpenChange={setConnectDialogOpen}
          onConnected={() => {
            void checkPlaneConnection()
          }}
        />
      </div>
    )
  }

  const workspaces = planeStatus.workspaces ?? []
  const activeWorkspaceSlug = planeStatus.activeWorkspaceSlug
  const activeWorkspace = workspaces.find((w) => w.slug === activeWorkspaceSlug)

  const handleRefresh = (): void => {
    if (activeWorkspaceSlug) {
      void fetchPlaneIssues({
        workspaceSlug: activeWorkspaceSlug,
        projectId: selectedProjectId === 'all' ? undefined : selectedProjectId
      })
    }
  }

  const handleOpenInWorktree = (issue: PlaneIssue): void => {
    const slug = issue.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
    const prefilledName = `plane/${issue.key.toLowerCase()}${slug ? `-${slug}` : ''}`
    useAppStore.getState().openModal('new-workspace-composer', {
      linkedWorkItem: {
        provider: 'plane',
        type: 'issue',
        number: issue.sequenceId,
        title: `${issue.key} ${issue.title}`,
        url: issue.url,
        planeIdentifier: issue.key
      },
      prefilledName,
      telemetrySource: 'sidebar'
    })
  }

  return (
    <div className="mt-3 flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-border/50 bg-background shadow-sm">
      {/* Plane Workspace & Project Selector Bar */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/50 bg-muted/20 px-3 py-2">
        <div className="flex flex-wrap items-center gap-2">
          {workspaces.length > 1 && (
            <Select
              value={activeWorkspaceSlug ?? ''}
              onValueChange={(val) => void selectPlaneWorkspace(val)}
            >
              <SelectTrigger className="h-7 w-[160px] text-xs">
                <SelectValue
                  placeholder={translate(
                    'auto.components.task.page.plane.selectWorkspace',
                    'Select workspace'
                  )}
                />
              </SelectTrigger>
              <SelectContent>
                {workspaces.map((w) => (
                  <SelectItem key={w.slug} value={w.slug} className="text-xs">
                    {w.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}

          <Select value={selectedProjectId} onValueChange={setSelectedProjectId}>
            <SelectTrigger className="h-7 min-w-[140px] text-xs">
              <SelectValue
                placeholder={translate(
                  'auto.components.task.page.plane.allProjects',
                  'All Projects'
                )}
              />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all" className="text-xs">
                {translate('auto.components.task.page.plane.allProjects', 'All Projects')}
              </SelectItem>
              {planeProjects.map((p) => (
                <SelectItem key={p.id} value={p.id} className="text-xs">
                  {p.name} ({p.identifier})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={handleRefresh}
            disabled={planeLoading}
            title={translate('auto.components.task.page.plane.refreshIssues', 'Refresh issues')}
          >
            <RefreshCw className={`size-3.5 ${planeLoading ? 'animate-spin' : ''}`} />
          </Button>
        </div>

        {activeWorkspace && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 gap-1 text-xs text-muted-foreground hover:text-foreground"
            onClick={() => {
              const url =
                activeWorkspace.url || `${planeStatus.instanceUrl}/${activeWorkspace.slug}`
              void window.api.shell.openUrl(url)
            }}
          >
            <span>{translate('auto.components.task.page.plane.openInPlane', 'Open in Plane')}</span>
            <ExternalLink className="size-3" />
          </Button>
        )}
      </div>

      {/* Issues Content Area */}
      <div className="flex min-h-0 flex-1 overflow-auto scrollbar-sleek">
        {planeLoading && planeIssues.length === 0 ? (
          <div className="flex flex-1 items-center justify-center py-12">
            <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : planeIssues.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center py-14 text-center">
            <p className="text-sm font-medium text-foreground">
              {translate('auto.components.task.page.plane.noIssuesFound', 'No issues found')}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {translate(
                'auto.components.task.page.plane.createIssueHint',
                'Create an issue in Plane to see it here.'
              )}
            </p>
          </div>
        ) : (
          <div className="w-full divide-y divide-border/40">
            {planeIssues.map((issue) => (
              <PlaneIssueRow key={issue.id} issue={issue} onOpenInWorktree={handleOpenInWorktree} />
            ))}
          </div>
        )}
      </div>

      <PlaneConnectDialog
        open={connectDialogOpen}
        onOpenChange={setConnectDialogOpen}
        onConnected={() => {
          void checkPlaneConnection()
        }}
      />
    </div>
  )
}
