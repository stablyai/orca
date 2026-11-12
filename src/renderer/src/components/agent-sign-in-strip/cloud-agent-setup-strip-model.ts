// PC-3b: the Orca Cloud pane strip for an agent that isn't set up yet. The launch holds; "Set up
// once" runs the same one-time setup as Settings › Accounts › Orca Cloud (S0) right in the pane,
// and once it's saved the strip offers "Start {{agent}}". Pure: the strip renders what this returns.
import type { Translate } from '@/i18n/use-translate'
import { setupFailureCopy } from '@/components/settings/agent-accounts/orca-cloud-accounts-copy'
import type { OrcaCloudAgentSetup } from '../../../../shared/orca-cloud-agents/orca-cloud-agents-wire'
import type { HostAgentSignInAgent } from '../../../../shared/host-agent-sign-in-status'
import { HOST_AGENT_SIGN_IN_AGENT_NAME } from '../../../../shared/host-agent-sign-in-status'
import type { CloudStripModel } from './cloud-agent-strip-model'

function base(agent: string, t: Translate): CloudStripModel {
  const title = t('agentSignInStrip.notSetUp', '{{agent}} isn’t set up for Orca Cloud', { agent })
  return {
    status: 'setup',
    title,
    detail: t('agentSignInStrip.notSetUpDetail', 'Set up once. Every cloud workspace uses it.'),
    description: null,
    primary: {
      label: t('agentSignInStrip.setUpOnce', 'Set up once'),
      action: { kind: 'setUpOnce' }
    },
    code: null,
    paste: null,
    otherWays: false,
    announcement: title
  }
}

/** A detail with `inline code` marks, as one sentence for a screen reader. */
function plainText(text: string): string {
  return text.replaceAll('`', '')
}

export function setupCodePaste(
  agent: HostAgentSignInAgent,
  code: 'checking' | 'rejected' | undefined,
  t: Translate,
  /** The CLI hasn't shown the fresh link yet: the field shows, disabled. */
  options: { waiting?: boolean } = {}
): NonNullable<CloudStripModel['paste']> {
  const name = HOST_AGENT_SIGN_IN_AGENT_NAME[agent]
  return {
    submitting: code === 'checking',
    refusal:
      code === 'rejected'
        ? t(
            'agentSignInStrip.setupCodeRejected',
            'That code didn’t work. Paste the newest code from the sign-in page, or open it again.'
          )
        : null,
    secretLabel: t('agentSignInStrip.setupCodeLabel', 'Code from {{agent}}’s sign-in page', {
      agent: name
    }),
    ...(options.waiting ? { disabled: true } : {}),
    setupCode: {
      placeholder: t('agentSignInStrip.setupCodePlaceholder', 'Paste code'),
      submitLabel:
        code === 'checking'
          ? t('agentSignInStrip.setupCodeChecking', 'Checking the code…')
          : t('agentSignInStrip.finishSetup', 'Finish setup')
    }
  }
}

export function cloudAgentSetupStripModel(args: {
  agent: HostAgentSignInAgent
  setup: OrcaCloudAgentSetup
  /** The Orca account (or a key) now covers the agent: offer to start it. */
  ready: boolean
  t: Translate
}): CloudStripModel {
  const { setup, t } = args
  const agent = HOST_AGENT_SIGN_IN_AGENT_NAME[args.agent]
  const need = base(agent, t)
  if (args.ready) {
    const title = t('agentSignInStrip.setUpDone', '{{agent}} is set up for Orca Cloud', { agent })
    return {
      ...need,
      status: 'done',
      title,
      detail: t('agentSignInStrip.setUpDoneDetail', 'Every cloud workspace uses it from now on.'),
      primary: {
        label: t('agentSignInStrip.startAgent', 'Start {{agent}}', { agent }),
        narrowLabel: t('agentSignInStrip.start', 'Start'),
        action: { kind: 'start' }
      },
      announcement: t(
        'agentSignInStrip.setUpDoneAnnounce',
        '{{agent}} is set up. Start it when you’re ready.',
        {
          agent
        }
      )
    }
  }
  switch (setup.phase) {
    case 'idle':
    case 'saved':
      return need
    case 'browser':
      return {
        ...need,
        status: setup.code === 'rejected' ? 'warning' : 'busy',
        // A refusal leads at every width; nothing is loading then, so the warning icon (design-squad).
        ...(setup.code === 'rejected'
          ? { title: t('agentSignInStrip.setupCodeRejectedTitle', 'Code didn’t work') }
          : {}),
        // A refused code stays the detail until the next paste or "Open again".
        detail:
          setup.code === 'rejected'
            ? // The title already says "Code didn’t work": the detail doesn't repeat it (design-squad).
              t(
                'agentSignInStrip.setupCodeRejectedDetail',
                'Paste the newest code from the sign-in page, or open it again.'
              )
            : setup.acceptsCode
              ? t(
                  'agentSignInStrip.finishInBrowserPaste',
                  'Finish in your browser, then paste the code here.'
                )
              : t('agentSignInStrip.finishInBrowser', 'Finish in your browser'),
        // Claude's page shows a code to bring back: [Paste code] [Finish setup] [Open again].
        // After a refusal the CLI takes a moment to show a fresh link: the field and "Open again" stay
        // in place, disabled, so nothing actionable disappears (design-squad).
        paste:
          setup.acceptsCode || setup.code === 'rejected'
            ? setupCodePaste(args.agent, setup.code, t, { waiting: !setup.acceptsCode })
            : null,
        primary:
          setup.canReopen || setup.code === 'rejected'
            ? {
                label: t('agentSignInStrip.openAgain', 'Open again'),
                action: { kind: 'reopenSetup' },
                ...(setup.canReopen ? {} : { busy: true })
              }
            : null,
        announcement: t(
          'agentSignInStrip.waitingAnnounce',
          'Waiting for you to approve in your browser.'
        )
      }
    case 'preparing':
    case 'saving':
      return {
        ...need,
        status: 'busy',
        detail:
          setup.phase === 'saving'
            ? t('agentSignInStrip.saving', 'Saving to your Orca account')
            : t('agentSignInStrip.preparing', 'Getting sign-in ready'),
        primary: null,
        announcement:
          setup.phase === 'saving'
            ? t('agentSignInStrip.saving', 'Saving to your Orca account')
            : t('agentSignInStrip.preparing', 'Getting sign-in ready')
      }
    case 'device':
      return {
        ...need,
        title: t('agentSignInStrip.deviceTitle', 'Enter this code on auth.openai.com'),
        detail: t(
          'agentSignInStrip.deviceGuard',
          'Only continue if you started this sign-in in Orca.'
        ),
        primary: {
          label: t('agentSignInStrip.copyAndOpen', 'Copy code and open'),
          action: { kind: 'copyAndOpen', url: setup.verificationUrl, code: setup.userCode }
        },
        code: setup.userCode,
        announcement: t('agentSignInStrip.deviceAnnounce', 'Enter the code on auth.openai.com.')
      }
    case 'paste': {
      // The fallback when setup-token can't run here (no CLI, unreadable output) or the person chose
      // it: same layout and voice as the paste-code step (design-squad). `…` marks inline code.
      const rejected = setup.token === 'rejected'
      const title = rejected
        ? t('agentSignInStrip.pasteTokenRejectedTitle', 'Token didn’t work')
        : t('agentSignInStrip.pasteAgentTokenTitle', 'Paste a {{agent}} token', { agent })
      const detail = rejected
        ? t(
            'agentSignInStrip.pasteTokenRejectedDetail',
            'Paste the full token from `claude setup-token`, or run it again.'
          )
        : t(
            'agentSignInStrip.pasteAgentTokenDetail',
            'Run `claude setup-token` in any terminal where {{agent}} is installed, then paste the token here. It’s saved to your Orca account, never to a sandbox.',
            { agent }
          )
      return {
        ...need,
        status: rejected ? 'warning' : need.status,
        title,
        detail,
        primary: null,
        paste: {
          submitting: false,
          refusal: rejected ? plainText(detail) : null,
          secretLabel: t('agentSignInStrip.setupTokenLabel', 'Claude setup-token'),
          placeholder: t('agentSignInStrip.setupTokenPlaceholder', 'Paste token'),
          submitLabel: t('agentSignInStrip.finishSetup', 'Finish setup')
        },
        announcement: rejected ? `${title}. ${plainText(detail)}` : title
      }
    }
    case 'failed': {
      const copy = setupFailureCopy(args.agent, setup.error, t)
      return {
        ...need,
        status: 'error',
        title: copy.title,
        detail: copy.detail ?? need.detail,
        // An expired sign-in: "Open again" starts a fresh one with a new link (main restarts it).
        primary:
          setup.error === 'timed_out'
            ? {
                label: t('agentSignInStrip.openAgain', 'Open again'),
                action: { kind: 'reopenSetup' }
              }
            : { label: t('agentSignInStrip.tryAgain', 'Try again'), action: { kind: 'setUpOnce' } },
        announcement: copy.title
      }
    }
  }
}
