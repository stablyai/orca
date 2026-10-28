import React from 'react'
import { AlertTriangle, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { RepoBadgeMark } from '@/components/repo/RepoBadgeLabel'
import { translate } from '@/i18n/i18n'
import type { SelectedProjectResolution } from './resolve-project-setup-for-host'
import { getMultiRepoUnavailableCopy } from './multi-repo-composer-copy'

export type MultiProjectChipProject = {
  projectId: string
  displayName: string
  badgeColor: string
}

type MultiProjectChipsProps = {
  projects: readonly MultiProjectChipProject[]
  resolutions: readonly SelectedProjectResolution[]
  hostLabel: string
  onRemoveProject: (projectId: string) => void
  onChooseSetup: (projectId: string, setupId: string) => void
  disabled?: boolean
}

const MAX_CHIP_NAME_LENGTH = 16

function truncateName(name: string): string {
  return name.length > MAX_CHIP_NAME_LENGTH ? `${name.slice(0, MAX_CHIP_NAME_LENGTH - 1)}…` : name
}

export default function MultiProjectChips({
  projects,
  resolutions,
  hostLabel,
  onRemoveProject,
  onChooseSetup,
  disabled = false
}: MultiProjectChipsProps): React.JSX.Element {
  const byProject = new Map(resolutions.map((entry) => [entry.projectId, entry.resolution]))
  return (
    <ul className="flex flex-wrap items-center gap-1.5" aria-label={projectsLabel()}>
      {projects.map((project) => {
        const resolution = byProject.get(project.projectId)
        const failed = resolution?.status === 'unavailable'
        const ambiguous = resolution?.status === 'resolved' && resolution.eligible.length > 1
        return (
          <li key={project.projectId} className="flex max-w-full flex-col gap-0.5">
            <Badge variant="outline" aria-invalid={failed || undefined} className="max-w-full">
              {failed ? (
                <AlertTriangle aria-hidden="true" />
              ) : (
                <RepoBadgeMark color={project.badgeColor} />
              )}
              <span title={project.displayName} className="truncate">
                {truncateName(project.displayName)}
              </span>
              {ambiguous && resolution.status === 'resolved' ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      disabled={disabled}
                      title={resolution.setup.path}
                      aria-label={translate(
                        'auto.components.newWorkspace.multiRepo.chooseSetup',
                        'Choose the setup for {{project}}',
                        { project: project.displayName }
                      )}
                      className="truncate text-muted-foreground underline-offset-2 hover:underline"
                    >
                      {resolution.setup.displayName}
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start">
                    <DropdownMenuRadioGroup
                      value={resolution.setup.id}
                      onValueChange={(setupId) => onChooseSetup(project.projectId, setupId)}
                    >
                      {resolution.eligible.map((setup) => (
                        <DropdownMenuRadioItem key={setup.id} value={setup.id}>
                          <span className="truncate">{setup.displayName}</span>
                          <span className="ml-2 truncate text-muted-foreground">{setup.path}</span>
                        </DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null}
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                disabled={disabled}
                onClick={() => onRemoveProject(project.projectId)}
                aria-label={translate(
                  'auto.components.newWorkspace.multiRepo.removeProject',
                  'Remove {{project}}',
                  { project: project.displayName }
                )}
              >
                <X aria-hidden="true" />
              </Button>
            </Badge>
            {resolution?.status === 'unavailable' ? (
              <span role="status" className="text-[11px] text-destructive">
                {getMultiRepoUnavailableCopy(resolution.reason, hostLabel)}
              </span>
            ) : null}
          </li>
        )
      })}
    </ul>
  )
}

function projectsLabel(): string {
  return translate('auto.components.newWorkspace.multiRepo.selectedProjects', 'Selected projects')
}
