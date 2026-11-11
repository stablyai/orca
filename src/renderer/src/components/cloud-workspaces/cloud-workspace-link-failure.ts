// What a cloud workspace link that didn't resolve tells the user. A W-number link names the
// workspace ("You don't have access to W-12."); one for a team you're in but don't have active
// offers to switch to that team and open it.
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import {
  formatWorkspaceNumber,
  type CloudWorkspaceLinkTarget
} from '../../../../shared/cloud-workspaces/cloud-workspaces-wire'
import { describeError } from './cloud-workspace-errors'

type Failure = { error: string; reason?: string; orgId?: string }

export function reportCloudWorkspaceLinkFailure(
  target: CloudWorkspaceLinkTarget,
  failure: Failure,
  /** Opens the same link again (after a team switch). */
  retry: () => void
): void {
  if (target.kind === 'number' && failure.error === 'not_found') {
    const label = formatWorkspaceNumber(target.number)
    if (failure.reason !== 'other_org' || !offerTeamSwitch(failure.orgId, label, retry)) {
      toast.error(
        translate(
          'auto.components.cloudWorkspaces.linkNoAccess',
          "You don't have access to {{number}}.",
          {
            number: label
          }
        )
      )
    }
    return
  }
  toast.error(
    failure.error === 'not_found'
      ? translate(
          'auto.components.cloudWorkspaces.linkNotFound',
          'This link points to a private workspace, another team, or a workspace that was deleted.'
        )
      : describeError(failure.error, failure.reason)
  )
}

/** False when you are not in that team (then it's plain "no access"). */
function offerTeamSwitch(orgId: string | undefined, label: string, retry: () => void): boolean {
  const state = useAppStore.getState()
  const org = orgId
    ? state.orcaProfileAuthStatus?.organizations?.find((o) => o.orgId === orgId)
    : undefined
  if (!org) {
    return false
  }
  toast.info(
    translate('auto.components.cloudWorkspaces.linkOtherTeam2', '{{number}} is in {{team}}.', {
      number: label,
      team: org.name
    }),
    {
      action: {
        label: translate('auto.components.cloudWorkspaces.linkSwitchTeam', 'Switch and open'),
        onClick: () => {
          void state.selectOrcaProfileOrg(org.orgId).then(retry)
        }
      }
    }
  )
  return true
}
