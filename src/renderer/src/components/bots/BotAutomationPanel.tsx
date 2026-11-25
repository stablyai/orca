// A bot's automation in its side panel: the Automations page's detail pieces, sections and editors
// at panel width, read through the shared automation loader on the bot's own host. What is bot-only
// here: the crumb, Back/Escape and focus return, Edit in chat, and the host the bot names.
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
import { botAutomationPlaceKey } from './bot-automation-place'
import { openBotAutomation } from './bot-automation-open'
import { useBotAutomationEditing } from './use-bot-automation-editing'
import { BotAutomationDiscardDialog } from './BotAutomationDiscardDialog'

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
  onBack,
  onDeleted
}: {
  bot: Bot
  place: BotAutomationPlace
  /** Back to Activity; it restores focus and scroll. */
  onBack: () => void
  /** Deleted from here: back to Activity, focus on its Automations card. */
  onDeleted: () => void
}): React.JSX.Element {
  // Captured once: every read and action goes to the machine this was opened against.
  const [owner] = useState(() => automationOwnerForHostId(bot.hostId, useAppStore.getState()))
  const t = useTranslate()
  const backRef = useRef<HTMLButtonElement>(null)
  if (!owner) {
    return (
      <div className="@container flex min-h-0 flex-1 flex-col gap-3 px-2 py-3">
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
          onClick={() =>
            openBotAutomation({
              bot,
              automationId: place.automationId,
              runId: place.runId,
              intent: 'page'
            })
          }
        >
          {t('bots.automationPanel.openOnPage', 'Open in Automations')}{' '}
          <span aria-hidden="true">↗</span>
        </Button>
      </div>
    )
  }
  return (
    <BotAutomationScreen
      bot={bot}
      place={place}
      owner={owner}
      onBack={onBack}
      onDeleted={onDeleted}
      backRef={backRef}
    />
  )
}

function BotAutomationScreen({
  bot,
  place,
  owner,
  onBack,
  onDeleted,
  backRef
}: {
  bot: Bot
  place: BotAutomationPlace
  owner: AutomationOwnerRef
  onBack: () => void
  onDeleted: () => void
  backRef: React.RefObject<HTMLButtonElement | null>
}): React.JSX.Element {
  const region = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const screenKey = botAutomationPlaceKey(place)
  const details = useAutomationDetails({
    owner,
    automationId: place.automationId,
    recentLimit: BOT_AUTOMATION_RECENT_RUNS,
    runId: place.runId
  })
  const { editing, setEditing, discard } = useBotAutomationEditing(screenKey)
  const [confirmingBack, setConfirmingBack] = useState(false)
  const requestBack = (): void => {
    if (editing) {
      setConfirmingBack(true)
      return
    }
    onBack()
  }
  useAutomationDetailKeys({ scope: region, onBack: requestBack })
  // The screen takes focus when it opens, so Escape and screen readers start here.
  useEffect(() => {
    region.current?.focus({ preventScroll: true })
  }, [])
  const askInChat = (sentence: string): Promise<boolean> =>
    openBotHomeTab(bot, { draft: sentence }).catch(() => false)
  return (
    <div
      ref={region}
      role="region"
      aria-labelledby={titleId}
      tabIndex={-1}
      data-bot-automation-screen=""
      className="@container scrollbar-sleek flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-2 py-3 outline-none"
    >
      <Crumb bot={bot} onBack={requestBack} backRef={backRef} />
      <BotAutomationScreenBody
        bot={bot}
        owner={details.snapshot.owner}
        snapshot={details.snapshot}
        controller={details.controller}
        place={place}
        titleId={titleId}
        screenKey={screenKey}
        editing={editing}
        setEditing={setEditing}
        askInChat={askInChat}
        onDeleted={onDeleted}
        onRetired={onBack}
      />
      <BotAutomationDiscardDialog
        open={confirmingBack}
        section={editing?.section ?? 'when'}
        onKeep={() => setConfirmingBack(false)}
        onDiscard={() => {
          setConfirmingBack(false)
          discard()
          onBack()
        }}
      />
    </div>
  )
}
