import React, { useId } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import type { Automation } from '../../../../shared/automations/automation-definition'
import type { AutomationOwnerRef } from '../../../../shared/automations/ownership/automation-owner-ref'
import { botTargetChatTitle } from '../automations/authoring/automation-bot-runs-in-chat'
import {
  automationResultsPlace,
  automationWhenLines,
  automationZoneLabel
} from '../automations/details/automation-bot-facts'
import { DetailSection } from '../automations/details/automation-detail-sections'

export type SectionProps = { automation: Automation; owner: AutomationOwnerRef }

export function BotAutomationWhenSection(props: SectionProps): React.JSX.Element {
  const t = useTranslate()
  const titleId = useId()
  const { automation, owner } = props
  const zone = automationZoneLabel(automation, owner.authority)
  return (
    <DetailSection title={t('automations.botTarget.when', 'When')} titleId={titleId}>
      <div className="flex min-w-0 flex-col gap-1 px-4 py-3 text-[13px] @max-[16rem]:px-3">
        {automationWhenLines(automation).map((line) => (
          <p key={line} className="[overflow-wrap:anywhere]">
            {line}
          </p>
        ))}
        {zone ? (
          <p className="text-xs text-muted-foreground">
            {t('bots.automationPanel.zone', 'Times are in {{zone}}', { zone })}
          </p>
        ) : null}
      </div>
    </DetailSection>
  )
}

export function BotAutomationResultsSection(props: SectionProps): React.JSX.Element {
  const t = useTranslate()
  const titleId = useId()
  const { automation } = props
  return (
    <DetailSection
      title={t('components.native-chat.automationSaved.results', 'Results')}
      titleId={titleId}
    >
      <div className="flex min-w-0 flex-col gap-1 px-4 py-3 text-[13px] @max-[16rem]:px-3">
        <p className="[overflow-wrap:anywhere]">
          {automationResultsPlace(automation.bot?.resultsTo)}
        </p>
        {automation.bot?.chat ? (
          <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
            {t('automations.botTarget.runsIn', 'Runs in')}:{' '}
            {botTargetChatTitle(automation.bot.chat)}
          </p>
        ) : null}
      </div>
    </DetailSection>
  )
}
