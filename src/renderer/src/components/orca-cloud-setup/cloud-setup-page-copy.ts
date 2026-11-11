// Words for the Orca Cloud setup page: each step's stepper label, and the current step's title,
// lead and note. Copy follows the product glossary (Orca Cloud, sandbox hours, Team plan).
import type { Translate } from '@/i18n/use-translate'
import type { CloudSetupStep } from '@/components/new-workspace/run-on/cloud-start-model'
import { sessionDetailCopy } from '@/components/new-workspace/run-on/cloud-setup-session-copy'
import type { CloudSetupPageModel } from './cloud-setup-page-model'

export function stepLabel(step: CloudSetupStep, t: Translate): string {
  switch (step.id) {
    case 'account':
      return t('cloudSetupPage.step.account', 'Account')
    case 'team':
      return t('cloudSetupPage.step.team', 'Team')
    case 'plan':
      return step.need === 'trial'
        ? t('cloudSetupPage.step.trial', 'Trial')
        : t('cloudSetupPage.step.plan', 'Plan')
    case 'github':
      return t('cloudSetupPage.step.github', 'GitHub')
    case 'agent':
      return t('cloudSetupPage.step.agent', 'Agent')
  }
}

type StepCopy = { title: string; lead: string | null; note?: string | null }

function trialHours(step: CloudSetupStep): string | null {
  return step.trialSeconds ? String(Math.round((step.trialSeconds / 3600) * 10) / 10) : null
}

export function currentStepCopy(
  flow: Pick<CloudSetupPageModel, 'current' | 'action'>,
  t: Translate,
  agentLabel: string | null
): StepCopy {
  const step = flow.current
  const detail = step
    ? ((sessionDetailCopy(step, t) === undefined ? step.detail : sessionDetailCopy(step, t)) ??
      null)
    : null
  switch (flow.action) {
    case 'sign-in':
      return {
        title: t('cloudSetupPage.signIn.title', 'Sign in to Orca'),
        lead: t(
          'cloudSetupPage.signIn.lead',
          'Orca Cloud runs your agents in a cloud workspace, so they keep going with your laptop closed. Sign in or create an account in your browser. We’ll make a team for you.'
        ),
        note: t(
          'cloudSetupPage.signIn.note',
          'New teams get a trial with no card needed. This page picks up each step on its own.'
        )
      }
    case 'start-trial': {
      const hours = step ? trialHours(step) : null
      return {
        title: t('cloudSetupPage.trial.title', 'Start your free trial'),
        lead:
          hours === null
            ? t('cloudSetupPage.trial.leadNoHours', 'Try Orca Cloud on your team. No card needed.')
            : t(
                'cloudSetupPage.trial.lead',
                '{{hours}} sandbox hours to try Orca Cloud. No card needed.',
                {
                  hours,
                  count: Number(hours),
                  defaultValue_one: '{{hours}} sandbox hour to try Orca Cloud. No card needed.'
                }
              ),
        note: t('cloudSetupPage.trial.note', 'Nothing is charged until you choose a plan.')
      }
    }
    case 'choose-plan':
      return step?.need === 'trial-used-up'
        ? {
            title: t('cloudSetupPage.plan.trialUsedUpTitle', 'Your trial is used up'),
            lead: t(
              'cloudSetupPage.plan.trialUsedUpLead',
              'Choose a Team plan to keep using Orca Cloud. Checkout opens in your browser.'
            )
          }
        : step?.need === 'renew-plan'
          ? {
              title: t('cloudSetupPage.plan.renewTitle', 'Renew your Team plan'),
              lead: t(
                'cloudSetupPage.plan.renewLead',
                'Your Team plan ended. Renew it in your browser to start this workspace.'
              )
            }
          : {
              title: t('cloudSetupPage.plan.title', 'Choose a Team plan'),
              lead: t(
                'cloudSetupPage.plan.lead',
                'Orca Cloud needs a Team plan. Checkout opens in your browser.'
              )
            }
    case 'fix-billing':
      return {
        title:
          step?.need === 'payment'
            ? t('cloudSetupPage.billing.paymentTitle', 'Update your payment method')
            : step?.need === 'spend-cap'
              ? t('cloudSetupPage.billing.capTitle', 'Spend cap reached')
              : t('cloudSetupPage.billing.hoursTitle', 'Out of sandbox hours'),
        lead:
          step?.need === 'payment'
            ? t(
                'cloudSetupPage.billing.paymentLead',
                'The last payment failed. Update the card to keep going.'
              )
            : step?.need === 'spend-cap'
              ? t('cloudSetupPage.billing.capLead', 'Raise the spend cap to start this workspace.')
              : t('cloudSetupPage.billing.hoursLead', 'Turn on overage to start this workspace.')
      }
    case 'switch-team':
      return { title: t('cloudSetupPage.team.title', 'Switch to your team'), lead: detail }
    case 'github-install':
      return {
        title: t('cloudSetupPage.github.title', 'Give Orca Cloud access on GitHub'),
        // The row names the repository ("Orca Cloud can't reach acme/web yet").
        lead: detail,
        note: t(
          'cloudSetupPage.github.lead',
          'Orca Cloud clones your code from GitHub. Install the Orca Cloud app on this repository once.'
        )
      }
    case 'github-waiting':
      return {
        title: t('cloudSetupPage.github.waitingTitle', 'Waiting for approval on GitHub'),
        lead: detail,
        note: step?.note ?? null
      }
    case 'needs-repository':
      return {
        title: t('cloudSetupPage.repository.title', 'Orca Cloud needs a GitHub repository'),
        lead: detail,
        note: step?.note ?? null
      }
    case 'ask-owner':
      return {
        title: t('cloudSetupPage.owner.title', 'An owner or admin needs to fix this'),
        lead:
          detail ??
          t(
            'cloudSetupPage.owner.lead',
            'Orca Cloud needs a Team plan. Only owners and admins can choose one.'
          )
      }
    case 'agent':
      return {
        title: agentLabel
          ? t('cloudSetupPage.agent.title', 'Sign in to {{agent}} once', { agent: agentLabel })
          : t('cloudSetupPage.agent.titleGeneric', 'Sign in to your agent once'),
        lead: t(
          'cloudSetupPage.agent.lead',
          'Save your agent sign-in to your Orca account and every cloud workspace uses it. You can also skip this and sign in inside the workspace.'
        )
      }
    case 'checking':
      return {
        title: t('cloudSetupPage.checking.title', 'Checking your Orca Cloud account…'),
        lead: null
      }
    case 'done':
      return {
        title: t('cloudSetupPage.done.title', 'All set'),
        lead: t('cloudSetupPage.done.lead', 'Starting your cloud workspace…')
      }
  }
}
