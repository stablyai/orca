import type React from 'react'
import { Trans } from 'react-i18next'
import type { OrcaUninstallPlan } from '../../../../../../shared/uninstall/orca-uninstall-types'
import { i18n } from '@/i18n/i18n'
import { useIntlLocale, useTranslate, type Translate } from '@/i18n/use-translate'
import { SettingsGroupDisclosure } from '../../section-layout/SettingsGroupDisclosure'
import {
  countOrcaUninstallPendingKept,
  countOrcaUninstallProblems
} from './orca-uninstall-plan-state'
import { OrcaUninstallFooter } from './OrcaUninstallFooter'
import { describeOrcaUninstallHookTargets, OrcaUninstallRows } from './OrcaUninstallRows'
import { useOrcaUninstall, type OrcaUninstallModel } from './use-orca-uninstall'

// Parts are joined by Intl.ListFormat, so each one is a lowercase fragment.
function describePlanParts(plan: OrcaUninstallPlan, t: Translate, intlLocale: string): string {
  const parts: string[] = []
  const hookTargets = describeOrcaUninstallHookTargets(plan, t, intlLocale)
  if (hookTargets) {
    parts.push(
      t('settings.uninstall.summary.hooksIn', 'hooks in {{targets}}', { targets: hookTargets })
    )
  }
  if (plan.cliCommand) {
    parts.push(
      t('settings.uninstall.summary.cliCommand', 'the <cmd>{{name}}</cmd> CLI', {
        name: plan.cliCommand.commandName
      })
    )
  }
  if (plan.backgroundService) {
    parts.push(t('settings.uninstall.summary.service', 'the <cmd>orca serve</cmd> server'))
  }
  if (plan.terminalDaemon) {
    parts.push(t('settings.uninstall.summary.terminalDaemon', 'the terminal background process'))
  }
  // Scripts are part of the hooks; name them only when no agent or host entry is left.
  if (plan.hookScripts && !hookTargets) {
    parts.push(t('settings.uninstall.summary.hookScripts', 'hook scripts'))
  }
  if (parts.length === 0) {
    return t('settings.uninstall.summary.nothing', 'Nothing outside the app to remove.')
  }
  const list = new Intl.ListFormat(intlLocale, { type: 'conjunction' }).format(parts)
  return `${list.charAt(0).toLocaleUpperCase(intlLocale)}${list.slice(1)}.`
}

function OrcaUninstallSummary({
  model
}: {
  model: Pick<OrcaUninstallModel, 'plan' | 'loadFailed' | 'phase'>
}): React.JSX.Element {
  const t = useTranslate()
  const intlLocale = useIntlLocale()
  const { plan } = model
  if (!plan) {
    return (
      <>
        {model.loadFailed
          ? t('settings.uninstall.loadFailed', 'Orca could not check what it installed.')
          : t('settings.uninstall.summary.loading', 'Checking what Orca installed…')}
      </>
    )
  }
  if (model.phase === 'done') {
    const problems = countOrcaUninstallProblems(plan)
    if (problems === 0 && countOrcaUninstallPendingKept(plan) > 0) {
      return (
        <>
          {t(
            'settings.uninstall.summary.stillInUse',
            'Some Orca files are still in use, so they stay for now.'
          )}
        </>
      )
    }
    return (
      <>
        {problems === 0
          ? t('settings.uninstall.summary.done', 'Removed. Delete the app to finish.')
          : t(
              'settings.uninstall.summary.problems',
              '{{count}} items need you before you delete the app.',
              {
                count: problems,
                defaultValue_one: '1 item needs you before you delete the app.'
              }
            )}
      </>
    )
  }
  return (
    <Trans
      i18n={i18n}
      defaults={describePlanParts(plan, t, intlLocale)}
      components={{ cmd: <code className="font-mono" /> }}
    />
  )
}

/** The disclosure is the confirmation: expanding it lists every part before Uninstall is reachable. */
export function OrcaUninstallPanel({ model }: { model: OrcaUninstallModel }): React.JSX.Element {
  const t = useTranslate()
  return (
    <SettingsGroupDisclosure
      label={t('settings.uninstall.title', 'Uninstall Orca')}
      summary={<OrcaUninstallSummary model={model} />}
    >
      <div className="divide-y divide-border border-t border-border">
        <OrcaUninstallRows model={model} />
        <OrcaUninstallFooter model={model} />
      </div>
    </SettingsGroupDisclosure>
  )
}

export function OrcaUninstallSection(): React.JSX.Element {
  return <OrcaUninstallPanel model={useOrcaUninstall()} />
}
