import { defineFixture } from '../../component-fixtures/component-fixture'
import { getDefaultSettings } from '../../../../shared/constants'
import { makeRepo, makeWorktree } from '../worktree-jump/worktree-jump-palette-test-fixtures'
import { ProjectDefaultAgentMenuItem } from './ProjectDefaultAgentMenuItem'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import WorktreeCard from '../sidebar/workspace-card/surface/WorktreeCard'
import { ConfirmationDialogProvider } from '@/components/confirmation-dialog'
import { useAppStore } from '@/store'
import type { Project } from '../../../../shared/project-types'
import { projectAgentLaunchDefaultSchema } from '../../../../shared/agent-launch/project-agent-launch-default'

const repo = { ...makeRepo(), displayName: 'JobBoard' }
const project: Project = {
  id: 'preview-project',
  displayName: 'JobBoard',
  badgeColor: '',
  sourceRepoIds: [repo.id],
  createdAt: 0,
  updatedAt: 0,
  agentLaunchDefault: {
    agent: 'codex',
    surface: 'chat',
    choices: { model: 'project-model', options: { effort: 'high' } }
  }
}
const branches = [
  makeWorktree('preview-main', 'main', {
    repoId: repo.id,
    projectId: project.id,
    hostId: 'local',
    branch: 'refs/heads/main',
    isMainWorktree: true
  }),
  makeWorktree('preview-feature', 'feature/report-viewer', {
    repoId: repo.id,
    projectId: project.id,
    hostId: 'local',
    branch: 'refs/heads/feature/report-viewer'
  })
]

function fixture(openDefault: boolean) {
  return defineFixture({
    width: 860,
    store: {
      settings: {
        ...getDefaultSettings('/home/fixture'),
        compactWorktreeHeader: true,
        defaultTuiAgent: 'codex'
      },
      repos: [repo],
      projects: [project],
      worktreesByRepo: { [repo.id]: branches },
      detectedAgentIds: ['codex'],
      localDetectedAgentIdsByContext: { host: ['codex'] }
    },
    setup: () => {
      window.api.preflight.detectAgents = async () => ['codex']
      window.api.projects.update = async ({ updates }) => ({
        ...project,
        ...updates,
        agentLaunchDefault: projectAgentLaunchDefaultSchema
          .nullable()
          .parse(updates.agentLaunchDefault)
      })
      window.api.settings.set = async (updates) => ({
        ...useAppStore.getState().settings!,
        ...updates
      })
    },
    render: () => (
      <div className="min-h-[220px] bg-worktree-sidebar p-3 text-worktree-sidebar-foreground">
        <div className="w-80">
          <div className="flex h-6 items-center justify-between px-2 text-[13px] font-semibold">
            <span>JobBoard</span>
            <DropdownMenu defaultOpen modal={false}>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-xs" aria-label="Project actions">
                  ⋯
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <ProjectDefaultAgentMenuItem repo={repo} />
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          <ConfirmationDialogProvider>
            {branches.map((worktree) => (
              <WorktreeCard
                key={worktree.id}
                worktree={worktree}
                repo={repo}
                isActive={false}
                nativeDragEnabled={false}
                flushSurface
              />
            ))}
          </ConfirmationDialogProvider>
        </div>
      </div>
    ),
    interact: openDefault
      ? async () => {
          const trigger = document.querySelector<HTMLElement>(
            '[data-slot="dropdown-menu-sub-trigger"]'
          )
          trigger?.focus()
          trigger?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
        }
      : undefined
  })
}

export const projectDefault = fixture(false)
export const chooseDefault = fixture(true)
