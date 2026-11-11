// RA-11 copy (design-squad): the strip over an Orca Cloud pane whose agent was already running when
// its Orca-account sign-in expired. Same words as #315's pre-launch strip, then the per-pane restart.
import type { Translate } from '@/i18n/use-translate'
import type { CloudRunningStrip } from '@/lib/orca-cloud/cloud-running-agent-signout'
import { HOST_AGENT_SIGN_IN_AGENT_NAME } from '../../../../shared/host-agent-sign-in-status'
import type { CloudStripModel } from './cloud-agent-strip-model'

export function cloudRunningStripModel(strip: CloudRunningStrip, t: Translate): CloudStripModel {
  const agent = HOST_AGENT_SIGN_IN_AGENT_NAME[strip.agent]
  const base = { code: null, paste: null, otherWays: false, description: null }
  if (strip.phase === 'expired') {
    return {
      ...base,
      status: 'warning',
      title: t('agentSignInStrip.expired', 'Your {{agent}} sign-in expired', { agent }),
      compactTitle: t('agentSignInStrip.expiredCompact', '{{agent}} sign-in expired', { agent }),
      detail: t(
        'agentSignInStrip.runningExpiredDetail',
        'Renew to keep working. Your conversation is kept.'
      ),
      primary: { label: t('agentSignInStrip.renew', 'Renew'), action: { kind: 'renew' } },
      announcement: t(
        'agentSignInStrip.runningExpiredAnnounce',
        'Your {{agent}} sign-in expired. Renew to keep working. Your conversation is kept.',
        { agent }
      )
    }
  }
  const restart = t('agentSignInStrip.restartAgent', 'Restart {{agent}}', { agent })
  return {
    ...base,
    status: 'done',
    title: t('agentSignInStrip.renewed', '{{agent}} sign-in renewed', { agent }),
    compactTitle: t('agentSignInStrip.renewed', '{{agent}} sign-in renewed', { agent }),
    detail: strip.resumable
      ? t('agentSignInStrip.renewedResume', 'Restart {{agent}} to pick up where you left off.', {
          agent
        })
      : t('agentSignInStrip.renewedFresh', 'Starts a new conversation.'),
    primary: {
      label: restart,
      narrowLabel: t('agentSignInStrip.restart', 'Restart'),
      action: { kind: 'restart' }
    },
    dismiss: t('agentSignInStrip.dismiss', 'Dismiss'),
    announcement: t(
      'agentSignInStrip.renewedAnnounce',
      '{{agent}} sign-in renewed. Restart {{agent}} to use it.',
      { agent }
    )
  }
}
