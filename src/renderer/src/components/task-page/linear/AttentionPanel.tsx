import type { LinearIssue } from '../../../../../shared/linear/issue-types'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { isLocalLinearAttentionSource } from '../../../../../shared/linear/attention-routing'
import type { TaskPageComposerActionsModel } from '../../use-task-page-composer-actions'
import { linearWorkspaceScopeSignature } from '../../../../../shared/linear/workspace-types'
import type { LinearPersonalReadScope } from '../../../../../shared/linear/personal-read-types'
import { LinearAttentionList } from './AttentionList'

export function LinearAttentionPanel({
  model,
  onOpenIssue
}: {
  model: TaskPageComposerActionsModel
  onOpenIssue: (issue: LinearIssue) => void
}): React.JSX.Element {
  const [mode, setMode] = useState<'inbox' | 'triage'>('inbox')
  const profileId = useAppStore((state) => state.activeOrcaProfileId)
  const status = useAppStore((state) => state.linearStatus)
  const workspaceId = model.selectedLinearWorkspaceId ?? ''
  const workspace = model.linearWorkspaces.find((entry) => entry.id === workspaceId)
  const remote = !isLocalLinearAttentionSource(model.linearTaskSourceContext, model.settings)
  const teamId = model.linearTeamSelection.size === 1 ? [...model.linearTeamSelection][0] : null
  const scope: LinearPersonalReadScope | null =
    profileId && workspace?.viewerId && workspace.credentialEpoch
      ? {
          profileId,
          workspaceId,
          viewerId: workspace.viewerId,
          credentialRevision: workspace.credentialRevision ?? 0,
          credentialEpoch: workspace.credentialEpoch
        }
      : null
  const unavailable = remote
    ? translate(
        'linear.attention.remote',
        'This view requires a Linear connection on this desktop. Switch Tasks to a local source; remote credentials stay on their host.'
      )
    : !workspace
      ? translate('linear.attention.workspace', 'Select one connected Linear workspace above.')
      : (status.credentialError ??
        (mode === 'inbox' && (!scope || workspace.credentialOwnerProfileId !== profileId)
          ? translate(
              'linear.attention.reconnect',
              'Reconnect Linear in this Orca profile to confirm your personal Inbox identity.'
            )
          : mode === 'triage' && !teamId
            ? translate('linear.attention.team', 'Select one team above to read its Triage queue.')
            : null))
  const identity = JSON.stringify([
    mode,
    profileId,
    workspaceId,
    teamId,
    scope,
    unavailable,
    linearWorkspaceScopeSignature(status)
  ])
  return (
    <section
      aria-label={translate('linear.attention.label', 'Linear attention')}
      className="mt-4 flex min-h-0 flex-1 flex-col gap-4"
    >
      <div className="flex items-center gap-2">
        <Button
          variant={mode === 'inbox' ? 'secondary' : 'ghost'}
          size="sm"
          aria-pressed={mode === 'inbox'}
          onClick={() => setMode('inbox')}
        >
          {translate('linear.attention.inbox', 'Personal Inbox')}
        </Button>
        <Button
          variant={mode === 'triage' ? 'secondary' : 'ghost'}
          size="sm"
          aria-pressed={mode === 'triage'}
          onClick={() => setMode('triage')}
        >
          {translate('linear.attention.triage', 'Team Triage')}
        </Button>
        {!remote && mode === 'inbox' && unavailable ? (
          <Button variant="outline" size="sm" onClick={() => model.setLinearConnectOpen(true)}>
            {translate('linear.attention.connect', 'Connect Linear')}
          </Button>
        ) : null}
      </div>
      <LinearAttentionList
        key={identity}
        onOpenIssue={onOpenIssue}
        mode={mode}
        workspaceId={workspaceId}
        teamId={teamId ?? null}
        scope={scope}
        unavailable={unavailable}
      />
    </section>
  )
}
