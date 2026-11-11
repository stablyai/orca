// RA-11 copy (design-squad): the strip over an Orca Cloud pane whose agent was already running when
// its Orca-account sign-in expired. Same words as #315's pre-launch strip, then the per-pane restart.
import type { Translate } from '@/i18n/use-translate'
import type { CloudRunningStrip } from '@/lib/orca-cloud/cloud-running-agent-signout'
import type { CloudAgentRestartAttempt } from '@/lib/orca-cloud/cloud-agent-restart-attempt'
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

/** The strip while a Restart runs ("Restarting…", button disabled) or after it failed (Try again). */
export function cloudRestartAttemptModel(
  attempt: CloudAgentRestartAttempt,
  t: Translate
): CloudStripModel {
  const agent = HOST_AGENT_SIGN_IN_AGENT_NAME[attempt.agent]
  const base = { code: null, paste: null, otherWays: false, description: null }
  if (attempt.phase === 'restarting') {
    const title = t('agentSignInStrip.restarting', 'Restarting {{agent}}…', { agent })
    return {
      ...base,
      status: 'busy',
      title,
      compactTitle: title,
      // Neutral while it runs: a recorded session may turn out to have no conversation (RA-11e).
      detail: attempt.resumable ? '' : t('agentSignInStrip.renewedFresh', 'Starts a new conversation.'),
      // The spinner and the words are the whole state: no button to click twice.
      primary: null,
      noClose: true,
      announcement: title
    }
  }
  const title = t('agentSignInStrip.restartFailed', 'Couldn’t restart {{agent}}', { agent })
  return {
    ...base,
    status: 'error',
    title,
    compactTitle: title,
    // Never "Try again." twice: the body names the reason when one is known, else stays empty.
    detail:
      attempt.failure === 'hostUnresponsive'
        ? t('agentSignInStrip.restartHostUnresponsive', 'The workspace didn’t respond.')
        : '',
    primary: {
      label: t('agentSignInStrip.tryAgain', 'Try again'),
      action: { kind: 'restart' }
    },
    dismiss: t('agentSignInStrip.dismiss', 'Dismiss'),
    announcement: t(
      'agentSignInStrip.restartFailedAnnounce',
      'Couldn’t restart {{agent}}. Try again.',
      {
        agent
      }
    )
  }
}

/** RA-11e: the resume found no conversation, so the agent started a new one. Shown briefly. */
export function cloudRestartFreshModel(
  agent: CloudAgentRestartAttempt['agent'],
  t: Translate
): CloudStripModel {
  const title = t('agentSignInStrip.startedFresh', 'Started a new conversation.')
  const detail = t('agentSignInStrip.startedFreshDetail', '{{agent}} had nothing to pick up.', {
    agent: HOST_AGENT_SIGN_IN_AGENT_NAME[agent]
  })
  return {
    code: null,
    paste: null,
    otherWays: false,
    description: null,
    status: 'done',
    title,
    compactTitle: title,
    detail,
    primary: null,
    noClose: true,
    announcement: `${title} ${detail}`
  }
}
