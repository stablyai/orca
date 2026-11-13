import { useEffect } from 'react'
import { hideCloudToast, showCloudToast } from '@/components/orca-cloud/cloud-toast-stack'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import { claimMfaToast, mfaDeadlineDate } from './team-mfa-copy'
import { useTeamMfaGate } from './TeamMfaGate'

/**
 * The MFA notice in the sidebar's banner stack, for the active team: a countdown while there is
 * still time, and "no access until you set it up" after the deadline. Renders nothing for a
 * personal account, a team with no policy, or a member who already has MFA, which is almost
 * everyone.
 *
 * The sidebar can be collapsed, so this is a reminder, not the enforcement surface: a refused
 * team resource shows TeamMfaRefused in its own place whether or not the sidebar is visible.
 */
export function TeamMfaSidebarBanner(): React.JSX.Element | null {
  const gate = useTeamMfaGate()
  const t = useTranslate()
  const locale = useIntlLocale()
  const toast = gate.pendingToast
  const orgId = toast?.orgId
  const enforceAt = toast?.enforceAt
  // One toast per team and deadline, for people who keep the sidebar collapsed. Not tied to any
  // workspace, so it shows wherever they are; the sidebar card stays as the lasting reminder.
  useEffect(() => {
    if (!toast || orgId === undefined || enforceAt === undefined) {
      return
    }
    if (!claimMfaToast(readLocalStorage(), orgId, enforceAt)) {
      return
    }
    const id = `team-mfa:${orgId}`
    showCloudToast(id, {
      priority: 'action',
      lines: [
        {
          key: 'mfa',
          text: t('auto.components.teamMfa.toast', '{{value0}} requires MFA from {{value1}}.', {
            value0: toast.teamName,
            value1: mfaDeadlineDate(enforceAt, locale)
          }),
          action: {
            label: t('auto.components.teamMfa.setUp', 'Set up MFA'),
            primary: true,
            // A plain button: toasts no longer carry a Copy link chevron (AUTH-ONLY-COPY-LINK).
            // The sidebar card and Settings, Account keep the split button.
            onClick: () => {
              void window.api.shell.openUrl(toast.setupUrl)
              hideCloudToast(id)
            }
          }
        }
      ]
    })
    // Deliberately keyed on the team and deadline only: copy or locale changes must not re-show.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId, enforceAt])
  return gate.sidebarBanner
}

function readLocalStorage(): Storage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

/**
 * In place of a team resource the server refused with `mfa_required`: the setup screen, or (when
 * the policy cannot be read to fill it in) nothing, so the caller's own error copy shows.
 */
export function TeamMfaRefused(): React.JSX.Element | null {
  return useTeamMfaGate({ forceBlocked: true }).blocked
}
