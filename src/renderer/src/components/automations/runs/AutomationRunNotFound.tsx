import React from 'react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { AutomationsPageFrame, AutomationsPageTitle } from '../AutomationsPageFrame'
import type { AutomationRunNotFound as NotFound } from '../automation-page-state'

/** A deep link whose run or automation was deleted: say so, and offer the way back. */
export function AutomationRunNotFound({
  nav,
  notFound,
  automationName,
  onShowAutomations,
  onShowAutomation
}: {
  nav: React.ReactNode
  notFound: NotFound
  /** Present when the automation still exists. */
  automationName: string | null
  onShowAutomations: () => void
  onShowAutomation: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const runGone = notFound.kind === 'run'
  return (
    <AutomationsPageFrame nav={nav}>
      <div className="flex flex-col items-center gap-2 px-6 py-16 text-center">
        <AutomationsPageTitle className="text-base">
          {runGone
            ? t('auto.components.automations.runNotFound.runTitle', 'This run no longer exists')
            : t(
                'auto.components.automations.runNotFound.automationTitle',
                'This automation no longer exists'
              )}
        </AutomationsPageTitle>
        <p className="max-w-md text-sm text-muted-foreground">
          {runGone
            ? t(
                'auto.components.automations.runNotFound.runDescription',
                'It was deleted or dropped from the retained run history.'
              )
            : t(
                'auto.components.automations.runNotFound.automationDescription',
                'It was deleted, or its host no longer lists it.'
              )}
        </p>
        <div className="mt-3 flex flex-wrap justify-center gap-2">
          {runGone && automationName ? (
            <Button type="button" size="sm" title={automationName} onClick={onShowAutomation}>
              {t('auto.components.automations.runNotFound.openThisAutomation', 'Open automation')}
            </Button>
          ) : null}
          <Button
            type="button"
            size="sm"
            variant={runGone && automationName ? 'outline' : 'default'}
            onClick={onShowAutomations}
          >
            {t('auto.components.automations.runNotFound.goToAutomations', 'Go to Automations')}
          </Button>
        </div>
      </div>
    </AutomationsPageFrame>
  )
}
