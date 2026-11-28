import type { Translate } from '@/i18n/use-translate'
import type { BranchAutoRenameFailureReason } from '../../../../../../shared/worktree/branch-auto-rename-failure-reason'

/** One short plain line for the card; the raw error stays out of it. */
export function autoNameFailureReasonText(
  reason: BranchAutoRenameFailureReason,
  t: Translate
): string {
  switch (reason.kind) {
    case 'model-unavailable':
      return reason.accountTier && reason.agent
        ? t(
            'auto.components.sidebar.AutoNameFailed.modelUnavailableOnAccount',
            '{{model}} isn’t available on this {{agent}} account',
            {
              model: reason.model,
              agent: reason.agent
            }
          )
        : reason.agent
          ? t(
              'auto.components.sidebar.AutoNameFailed.modelUnavailableForAgent',
              '{{model}} isn’t available for {{agent}}',
              {
                model: reason.model,
                agent: reason.agent
              }
            )
          : t(
              'auto.components.sidebar.AutoNameFailed.modelUnavailable',
              '{{model}} isn’t available',
              { model: reason.model }
            )
    case 'timed-out':
      return t('auto.components.sidebar.AutoNameFailed.timedOut', 'Timed out after {{seconds}}s', {
        seconds: reason.seconds
      })
    case 'agent-missing':
      return t('auto.components.sidebar.AutoNameFailed.agentMissing', '{{agent}} isn’t installed', {
        agent: reason.agent
      })
    case 'usage-limit':
      return reason.agent
        ? t(
            'auto.components.sidebar.AutoNameFailed.usageLimitAgent',
            '{{agent}} hit its usage limit',
            { agent: reason.agent }
          )
        : t(
            'auto.components.sidebar.AutoNameFailed.usageLimit',
            'The naming agent hit its usage limit'
          )
    case 'signed-out':
      return reason.agent
        ? t('auto.components.sidebar.AutoNameFailed.signedOutAgent', '{{agent}} isn’t signed in', {
            agent: reason.agent
          })
        : t('auto.components.sidebar.AutoNameFailed.signedOut', 'The naming agent isn’t signed in')
    case 'agent-failed':
      return t(
        'auto.components.sidebar.AutoNameFailed.agentFailed',
        '{{agent}} exited with an error',
        { agent: reason.agent }
      )
    case 'no-agent':
      return t('auto.components.sidebar.AutoNameFailed.noAgent', 'No naming agent is set up')
    case 'publish-check':
      return t(
        'auto.components.sidebar.AutoNameFailed.publishCheck',
        'Couldn’t check whether the branch was pushed'
      )
    case 'environment':
      return t(
        'auto.components.sidebar.AutoNameFailed.environment',
        'Couldn’t start the naming agent'
      )
    case 'empty-name':
      return t(
        'auto.components.sidebar.AutoNameFailed.emptyName',
        'The agent returned no usable name'
      )
    case 'unknown':
      return t('auto.components.sidebar.AutoNameFailed.unknown', 'The naming agent hit an error')
  }
}
