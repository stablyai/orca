import React from 'react'
import { LoaderCircle, PlugZap } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type { NewWorkspaceComposerCardProps } from './new-workspace-composer-card-props'
import { EMPTY_PROJECT_OPTIONS } from './new-workspace-composer-card-props'

type ProjectNoticeProps = Pick<
  NewWorkspaceComposerCardProps,
  'projectOptions' | 'projectError' | 'emptyProjectMessage'
> & { projectDescriptionId: string }

/** Project error, or the empty-list hint; both label the project combobox via `projectDescriptionId`. */
export function ProjectNotice({
  projectOptions = EMPTY_PROJECT_OPTIONS,
  projectError,
  emptyProjectMessage,
  projectDescriptionId
}: ProjectNoticeProps): React.JSX.Element | null {
  if (projectError) {
    return (
      <p id={projectDescriptionId} className="text-[11px] text-destructive">
        {projectError}
      </p>
    )
  }
  if (projectOptions.length === 0) {
    return (
      <p id={projectDescriptionId} className="text-[11px] text-muted-foreground">
        {emptyProjectMessage ??
          translate(
            'auto.components.NewWorkspaceComposerCard.addProjectBeforeWorkspace',
            'Add a project before creating a workspace.'
          )}
      </p>
    )
  }
  return null
}

export function EphemeralVmRecipeErrorNotice({
  ephemeralVmRecipeError
}: Pick<NewWorkspaceComposerCardProps, 'ephemeralVmRecipeError'>): React.JSX.Element | null {
  if (!ephemeralVmRecipeError) {
    return null
  }
  return (
    <p className="whitespace-pre-line text-[11px] text-destructive">{ephemeralVmRecipeError}</p>
  )
}

type ConnectHostNoticeProps = Pick<
  NewWorkspaceComposerCardProps,
  | 'selectedRepoConnectionId'
  | 'selectedRepoRequiresConnection'
  | 'selectedRepoConnectInProgress'
  | 'onConnectSelectedRepo'
> & {
  sshStatusLabel: string
  connectButtonLabel: string
  selectedProjectName: string
}

export function ConnectHostNotice({
  selectedRepoRequiresConnection,
  selectedRepoConnectionId,
  selectedRepoConnectInProgress,
  onConnectSelectedRepo,
  sshStatusLabel,
  connectButtonLabel,
  selectedProjectName
}: ConnectHostNoticeProps): React.JSX.Element | null {
  if (!selectedRepoRequiresConnection || !selectedRepoConnectionId) {
    return null
  }
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-center justify-between gap-3 rounded-md border border-border/70 bg-muted/35 px-3 py-2"
    >
      <div className="min-w-0">
        <div className="truncate text-xs font-medium text-foreground">
          {translate('auto.components.NewWorkspaceComposerCard.b5a0796911', 'Connect')}{' '}
          {selectedProjectName}
        </div>
        <div className="mt-0.5 text-[11px] text-muted-foreground">{sshStatusLabel}</div>
      </div>
      <Button
        type="button"
        variant="outline"
        size="xs"
        onClick={() => void onConnectSelectedRepo()}
        disabled={selectedRepoConnectInProgress}
        className="shrink-0"
      >
        {selectedRepoConnectInProgress ? (
          <LoaderCircle className="size-3.5 animate-spin" />
        ) : (
          <PlugZap className="size-3.5" />
        )}
        {selectedRepoConnectInProgress
          ? translate('auto.components.NewWorkspaceComposerCard.f660aa1454', 'Connecting')
          : connectButtonLabel}
      </Button>
    </div>
  )
}

type NewWorkspaceComposerTargetNoticesProps = ProjectNoticeProps &
  Pick<NewWorkspaceComposerCardProps, 'ephemeralVmRecipeError'> &
  ConnectHostNoticeProps

/** Prompt-first layout: the pills carry no inline messages, so every notice stacks under the prompt box. */
export function NewWorkspaceComposerTargetNotices(
  props: NewWorkspaceComposerTargetNoticesProps
): React.JSX.Element | null {
  const { projectOptions = EMPTY_PROJECT_OPTIONS } = props
  const hasProjectNotice = Boolean(props.projectError) || projectOptions.length === 0
  const hasConnectNotice = Boolean(
    props.selectedRepoRequiresConnection && props.selectedRepoConnectionId
  )
  if (!hasProjectNotice && !props.ephemeralVmRecipeError && !hasConnectNotice) {
    return null
  }
  return (
    <div className="space-y-2">
      <ProjectNotice {...props} />
      <EphemeralVmRecipeErrorNotice {...props} />
      <ConnectHostNotice {...props} />
    </div>
  )
}
