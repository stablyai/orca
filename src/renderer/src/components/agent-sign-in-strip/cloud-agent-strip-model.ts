// What the Orca Cloud sign-in strip shows (redesign §6, §9 "Strip"): account recovery (S4-c, card
// 13), or the per-workspace fallback while the Orca-account path is paused or never offered, driven
// by #40228's gate view. Pure: the strip renders whatever this returns.
import type { Translate } from '@/i18n/use-translate'
import type { AgentSignInGateView } from '@/lib/agent-sign-in/agent-sign-in-gate-store'
import type { CloudAgentStripReason } from '@/lib/orca-cloud/cloud-agent-launch-hold'
import type { HostAgentSignInAgent } from '../../../../shared/host-agent-sign-in-status'
import { HOST_AGENT_SIGN_IN_AGENT_NAME } from '../../../../shared/host-agent-sign-in-status'

export type CloudStripStatus = 'need' | 'setup' | 'warning' | 'busy' | 'error' | 'done'

export type CloudStripPrimary =
  | { kind: 'renew' }
  | { kind: 'signIn' }
  | { kind: 'openAgain'; url: string }
  | { kind: 'copyAndOpen'; url: string; code: string }
  | { kind: 'submitCode' }
  | { kind: 'retry' }
  | { kind: 'useDeviceCode' }
  /** RA-11: restart the running agent in its pane, resuming its conversation when it can. */
  | { kind: 'restart' }
  /** PC-3b: run the one-time Orca Cloud setup (S0) right from the pane. */
  | { kind: 'setUpOnce' }
  /** PC-3b: reopen the setup's browser page. */
  | { kind: 'reopenSetup' }
  /** PC-3b: the setup finished; start the held agent. */
  | { kind: 'start' }

export type CloudStripModel = {
  status: CloudStripStatus
  title: string
  /** Below 360 px the strip shows one line: this, then the primary. */
  compactTitle?: string
  detail: string
  /** Full sentence for the tooltip and aria-describedby when the detail is shortened. */
  description: string | null
  primary: { label: string; narrowLabel?: string; action: CloudStripPrimary; busy?: boolean } | null
  /** Device code shown inline (Copy beside it). */
  code: string | null
  /** The paste input replaces the primary. */
  paste: {
    submitting: boolean
    refusal: string | null
    /** PC-3b: a setup-token is a secret: masked, with this label (default: the claude.ai code). */
    secretLabel?: string
  } | null
  /** "Other ways" under ⋯: the code fallback and the key path. */
  otherWays: boolean
  /** Already on a code: ⋯ offers the paste fallback and Cancel instead of "Use a code". */
  codeStep?: boolean
  /** RA-11 state 2: a dismiss × with this label (the strip otherwise drops its × on Renew). */
  dismiss?: string
  /** RA-11 "Restarting…": nothing to close; the strip leaves with the result. */
  noClose?: boolean
  /** One sentence for the polite region. */
  announcement: string
}

const SITE: Record<HostAgentSignInAgent, string> = {
  claude: 'claude.ai',
  codex: 'auth.openai.com'
}

function needWorkspace(
  agent: string,
  reason: Exclude<CloudAgentStripReason, 'accountExpired'>,
  t: Translate
): CloudStripModel {
  const paused = reason === 'paused'
  return {
    status: 'need',
    title: t('agentSignInStrip.killSwitch', 'Sign in to {{agent}} for this workspace', { agent }),
    // Never "paused" for a provider this server never offered (#289).
    detail: paused
      ? t('agentSignInStrip.paused', 'Orca account sign-in is paused')
      : t('vmBuildAgents.notOffered', 'Signs in for each cloud workspace for now'),
    description: paused
      ? t(
          'agentSignInStrip.pausedFull',
          'Orca account sign-in is paused. This sign-in stays with this workspace.'
        )
      : t(
          'agentSignInStrip.notOfferedFull',
          'Signs in for each cloud workspace for now. This sign-in stays with this workspace.'
        ),
    primary: {
      label: t('agentSignInStrip.useMySignIn', 'Use my {{agent}} sign-in', { agent }),
      narrowLabel: t('agentSignInStrip.signIn', 'Sign in'),
      action: { kind: 'signIn' }
    },
    code: null,
    paste: null,
    otherWays: true,
    announcement: t('agentSignInStrip.killSwitch', 'Sign in to {{agent}} for this workspace', {
      agent
    })
  }
}

export function cloudAgentStripModel(args: {
  agent: HostAgentSignInAgent
  reason: CloudAgentStripReason
  /** #40228's gate step for the per-workspace sign-in; null for account recovery. */
  view: AgentSignInGateView | null
  hostLabel: string
  t: Translate
}): CloudStripModel {
  const { reason, view, t } = args
  const agent = HOST_AGENT_SIGN_IN_AGENT_NAME[args.agent]
  const site = SITE[args.agent]
  if (reason === 'accountExpired') {
    return {
      status: 'warning',
      title: t('agentSignInStrip.expired', 'Your {{agent}} sign-in expired', { agent }),
      compactTitle: t('agentSignInStrip.expiredCompact', '{{agent}} sign-in expired', { agent }),
      detail: t('agentSignInStrip.expiredDetail', 'Sign in once to fix every workspace'),
      description: null,
      primary: { label: t('agentSignInStrip.renew', 'Renew'), action: { kind: 'renew' } },
      code: null,
      paste: null,
      otherWays: false,
      announcement: t(
        'agentSignInStrip.expiredAnnounce',
        'Your {{agent}} sign-in expired. Renew it once to fix every workspace.',
        { agent }
      )
    }
  }
  const base = needWorkspace(agent, reason, t)
  if (!view || view.step === 'need') {
    return base
  }
  switch (view.step) {
    case 'starting':
    case 'waiting':
      return {
        ...base,
        status: 'busy',
        detail: t('agentSignInStrip.waiting', 'Approve on {{site}}', { site }),
        primary:
          view.step === 'waiting'
            ? {
                label: t('agentSignInStrip.openAgain', 'Open again'),
                action: { kind: 'openAgain', url: view.url }
              }
            : {
                label: t('agentSignInStrip.openAgain', 'Open again'),
                action: { kind: 'signIn' },
                busy: true
              },
        announcement: t(
          'agentSignInStrip.waitingAnnounce',
          'Waiting for you to approve in your browser.'
        )
      }
    case 'device':
      return {
        ...base,
        status: 'need',
        title: t('agentSignInStrip.deviceTitle', 'Enter this code on auth.openai.com'),
        detail: t(
          'agentSignInStrip.deviceGuard',
          'Only continue if you started this sign-in in Orca.'
        ),
        description: null,
        // One primary, like S0 and the build-sheet row (Neil): copy the code, then open the page.
        primary: {
          label: t('agentSignInStrip.copyAndOpen', 'Copy code and open'),
          action: { kind: 'copyAndOpen', url: view.url, code: view.userCode }
        },
        codeStep: true,
        code: view.userCode,
        announcement: t('agentSignInStrip.deviceAnnounce', 'Enter the code on auth.openai.com.')
      }
    case 'paste':
      return {
        ...base,
        title: t('agentSignInStrip.pasteTitle', 'Paste the code from claude.ai'),
        detail: t(
          'agentSignInStrip.deviceGuard',
          'Only continue if you started this sign-in in Orca.'
        ),
        description: null,
        primary: null,
        paste: { submitting: view.submitting, refusal: view.refusal },
        announcement: t('agentSignInStrip.pasteAnnounce', 'Paste the code from claude.ai.')
      }
    case 'signed':
      return {
        ...base,
        status: 'done',
        title: view.email
          ? t('agentSignInStrip.signedAs', 'Signed in as {{email}}', { email: view.email })
          : t('agentSignInStrip.signed', 'Signed in'),
        // C6 (deferred to #40228): the gate still proceeds on its own for another account.
        detail: view.expectedEmail
          ? t('agentSignInStrip.otherAccount', 'This computer uses {{expected}}', {
              expected: view.expectedEmail
            })
          : t('agentSignInStrip.doneDetail', 'For this workspace · starting {{agent}}', { agent }),
        description: null,
        primary: null,
        otherWays: false,
        announcement: t(
          'agentSignInStrip.doneAnnounce',
          '{{agent}} signed in for this workspace.',
          {
            agent
          }
        )
      }
    case 'error':
      return {
        ...base,
        status: 'error',
        title: errorTitle(view, agent, site, args.hostLabel, t),
        detail:
          view.kind === 'offline'
            ? t('agentSignInStrip.offlineDetail', 'Sign-in continues when it’s back')
            : t('agentSignInStrip.nothingChanged', 'Nothing was changed'),
        description: null,
        // C5 (deferred to #40228): a busy port still asks; the gate doesn't switch on its own.
        primary:
          view.kind === 'port_busy'
            ? {
                label: t('agentSignInStrip.useCode', 'Use a code instead'),
                action: { kind: 'useDeviceCode' }
              }
            : view.kind === 'offline'
              ? null
              : { label: t('agentSignInStrip.tryAgain', 'Try again'), action: { kind: 'retry' } },
        announcement: errorTitle(view, agent, site, args.hostLabel, t)
      }
  }
}

function errorTitle(
  view: Extract<AgentSignInGateView, { step: 'error' }>,
  agent: string,
  site: string,
  host: string,
  t: Translate
): string {
  switch (view.kind) {
    case 'timeout':
      return t('agentSignInStrip.timedOut', 'Sign-in timed out')
    case 'declined':
      return t('agentSignInStrip.declined', 'Sign-in was declined on {{site}}', { site })
    case 'offline':
      return t('agentSignInStrip.offline', 'Can’t reach {{host}}', { host })
    case 'port_busy':
      return t('agentSignInStrip.portBusy', 'The browser sign-in couldn’t start here')
    case 'failed':
      return t('agentSignInStrip.failed', '{{agent}} couldn’t finish signing in', { agent })
  }
}
