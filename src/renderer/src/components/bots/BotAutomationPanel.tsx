import React, { useEffect, useId, useRef, useState } from 'react'
import { ChevronLeft } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { openBotHomeTab } from '@/lib/bot-catalog'
import { useAppStore } from '@/store'
import type { Bot } from '../../../../shared/bot-types'
import type { AutomationOwnerRef } from '../../../../shared/automations/ownership/automation-owner-ref'
import { automationOwnerForHostId } from '../automations/hosts/automation-host-owner'
import { useAutomationDetails } from '../automations/details/use-automation-details'
import { useAutomationDetailKeys } from '../automations/details/use-automation-detail-keys'
import { BotAutomationScreenBody } from './BotAutomationScreenBody'
import type { BotAutomationPlace } from './bot-automation-place'

export const BOT_AUTOMATION_RECENT_RUNS = 5

function Crumb({
  bot,
  onBack,
  backRef
}: {
  bot: Bot
  onBack: () => void
  backRef: React.RefObject<HTMLButtonElement | null>
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <nav
      aria-label={t('bots.automationPanel.crumb', 'Automation')}
      className="flex min-w-0 items-center gap-1 text-sm"
    >
      <Button
        ref={backRef}
        type="button"
        variant="ghost"
        size="icon-sm"
        className="size-7 shrink-0"
        aria-label={t('bots.automationPanel.back', 'Back to Activity')}
        onClick={onBack}
      >
        <ChevronLeft className="size-4" />
      </Button>
      {/* Below 260px only the screen's name is left. */}
      <span className="min-w-0 truncate text-muted-foreground @max-[15rem]:hidden">{bot.name}</span>
      <span className="text-muted-foreground @max-[15rem]:hidden" aria-hidden>
        /
      </span>
      <span className="min-w-0 truncate font-medium">
        {t('bots.automationPanel.crumb', 'Automation')}
      </span>
    </nav>
  )
}

/** The Automation screen, or, for a bot this app can't route to, a way to the page. */
export function BotAutomationPanel({
  bot,
  place,
  onBack
}: {
  bot: Bot
  place: BotAutomationPlace
  /** Back to Activity; it restores focus and scroll. */
  onBack: () => void
}): React.JSX.Element {
  // Captured once: every read and action goes to the machine this was opened against.
  const [owner] = useState(() => place.owner ?? null)
  const t = useTranslate()
  const backRef = useRef<HTMLButtonElement>(null)
  const fallbackRegion = useRef<HTMLDivElement>(null)
  useAutomationDetailKeys({ scope: fallbackRegion, onBack })
  useEffect(() => {
    if (!owner) {
      backRef.current?.focus({ preventScroll: true })
    }
  }, [owner])
  if (!owner) {
    return (
      <div ref={fallbackRegion} className="@container flex min-h-0 flex-1 flex-col gap-3 px-2 py-3">
        <Crumb bot={bot} onBack={onBack} backRef={backRef} />
        <p className="px-2 text-sm text-muted-foreground">
          {t('bots.automationPanel.unroutable', "Can't reach {{name}}'s computer from this app.", {
            name: bot.name
          })}
        </p>
        <Button
          type="button"
          variant="link"
          size="inlineText"
          className="mx-2 self-start"
          onClick={() => {
            const state = useAppStore.getState()
            state.setPendingAutomationRunNavigation(null)
            state.openAutomationsPage()
          }}
        >
          {t('bots.automationPanel.openOnPage', 'Open in Automations')}{' '}
          <span aria-hidden="true">↗</span>
        </Button>
      </div>
    )
  }
  return (
    <BotAutomationScreen bot={bot} place={place} owner={owner} onBack={onBack} backRef={backRef} />
  )
}

function BotAutomationScreen({
  bot,
  place,
  owner,
  onBack,
  backRef
}: {
  bot: Bot
  place: BotAutomationPlace
  owner: AutomationOwnerRef
  onBack: () => void
  backRef: React.RefObject<HTMLButtonElement | null>
}): React.JSX.Element {
  const region = useRef<HTMLDivElement>(null)
  const t = useTranslate()
  const titleId = useId()
  const details = useAutomationDetails({
    owner,
    automationId: place.automationId,
    recentLimit: BOT_AUTOMATION_RECENT_RUNS,
    runId: place.runId
  })
  useAutomationDetailKeys({ scope: region, onBack })
  // The screen takes focus when it opens, so Escape and screen readers start here.
  useEffect(() => {
    region.current?.focus({ preventScroll: true })
  }, [])
  const canDraft = (): boolean => {
    if (details.controller.recheckOwner() !== 'same') {
      return false
    }
    const current = details.controller.getSnapshot()
    const target = automationOwnerForHostId(bot.hostId, useAppStore.getState())
    return Boolean(
      current.definition.value?.bot?.botId === bot.id &&
      target &&
      JSON.stringify(target) === JSON.stringify(current.owner)
    )
  }
  const askInChat = (sentence: string): Promise<boolean> =>
    canDraft()
      ? openBotHomeTab(bot, { draft: sentence, canContinue: canDraft }).catch(() => false)
      : Promise.resolve(false)
  return (
    <div
      ref={region}
      role="region"
      aria-label={t('bots.automationPanel.crumb', 'Automation')}
      aria-labelledby={details.snapshot.definition.value ? titleId : undefined}
      tabIndex={-1}
      data-bot-automation-screen=""
      className="@container scrollbar-sleek flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-2 py-3 outline-none"
    >
      <Crumb bot={bot} onBack={onBack} backRef={backRef} />
      <BotAutomationScreenBody
        bot={bot}
        owner={details.snapshot.owner}
        snapshot={details.snapshot}
        controller={details.controller}
        titleId={titleId}
        askInChat={askInChat}
        onRetired={onBack}
      />
    </div>
  )
}
