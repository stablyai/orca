// Automations in a bot's Activity panel: Tidy memory, Look around, automations and waits, failed first,
// then running, then soonest; paused ones last. Five show, then "All N automations". Folded, the rows
// in trouble stay listed under the header. An automation's Delete confirms here and keeps focus near it.
import { useLayoutEffect, useRef, useState } from 'react'
import { ChevronRight, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import { openBotHomeTab } from '@/lib/bot-catalog'
import { useAppStore } from '@/store'
import type { Bot } from '../../../../shared/bot-types'
import type { UpNextState } from '../../../../shared/bots/bot-look-around'
import { AutomationDeleteDialog } from '../automations/authoring/AutomationDeleteDialogs'
import { persistSkipDeleteAutomationConfirm } from '../automations/authoring/automation-delete-confirm-preference'
import { BotPanelSection } from './BotPanelSection'
import { useBotPanelFold } from './use-bot-panel-fold'
import {
  AUTOMATION_CARD_CAP,
  botAutomationCardView,
  useAutomationCardOrder,
  type BotAutomationCardRow
} from './bot-automation-card'
import { UpcomingItem, type BotAutomationRowDeletion } from './BotUpcomingRows'
import type { BotAutomationDeleteIntent, BotAutomationDeletion } from './use-bot-automation-delete'

/** A delete this section started, followed until its row is gone so focus can move off it. */
type FollowedDelete = {
  id: string
  rowKey: string
  /** Its own confirmation is still closing: that close places focus first. */
  awaitingClose: boolean
  /** The openable rows, in order, the last time its row rendered. */
  order: string[]
  /** It left for a reason other than this delete (folded, an item opened): focus stays put. */
  leftOtherwise: boolean
}

const ROW_OPEN = '[data-bot-row-open]'

/** The rendered rows whose button opens something, in order. */
function openableRowKeys(section: HTMLElement | null): string[] {
  if (!section) {
    return []
  }
  return [...section.querySelectorAll<HTMLElement>(ROW_OPEN)].flatMap((button) => {
    const key = button.closest<HTMLElement>('[data-bot-panel-row]')?.dataset.botPanelRow
    return key ? [key] : []
  })
}

function rowOpenButton(section: HTMLElement | null, rowKey: string): HTMLElement | null {
  return (
    section?.querySelector<HTMLElement>(
      `[data-bot-panel-row="${CSS.escape(rowKey)}"] ${ROW_OPEN}`
    ) ?? null
  )
}

/** Focus was left nowhere (on the page body), as when the focused row unmounts. */
const focusIsLost = (): boolean =>
  !document.activeElement || document.activeElement === document.body

export function BotUpcomingSection({
  bot,
  rows,
  hiddenKeys,
  upNext,
  hasAutomations,
  signInStops,
  now,
  deletion
}: {
  bot: Bot
  /** In the fixed order `botAutomationCardRows` gives, without hidden ones; the card ranks them. */
  rows: readonly BotAutomationCardRow[]
  /** The card keys of automations deleted here and hidden, so the rest keep their places. */
  hiddenKeys: ReadonlySet<string>
  upNext: UpNextState | undefined
  /** It has automations or waits of its own, beyond Tidy memory and Look around. */
  hasAutomations: boolean
  /** Automations whose sign-in stop Needs you lists. */
  signInStops: ReadonlySet<string>
  now: number
  deletion: BotAutomationDeletion
}): React.JSX.Element {
  const t = useTranslate()
  const ordered = useAutomationCardOrder(rows, hiddenKeys)
  const { shown, listed, listedPaused } = botAutomationCardView(ordered)
  const shownKeys = new Set(shown.map((row) => row.key))
  const foldedRows = ordered.filter(
    (row) =>
      shownKeys.has(row.key) ||
      (row.kind === 'automation' && deletion.pending.get(row.row.automation.id)?.admittedAsTrouble)
  )
  const newLabel = t('bots.automations.new', 'New automation')
  const fold = useBotPanelFold(bot.id, 'automations')
  const section = useRef<HTMLElement | null>(null)
  const newButton = useRef<HTMLButtonElement | null>(null)
  const confirmButton = useRef<HTMLButtonElement | null>(null)
  const [target, setTarget] = useState<(BotAutomationDeleteIntent & { rowKey: string }) | null>(
    null
  )
  const [dontAskAgain, setDontAskAgain] = useState(false)
  // Shows the header's idle actions so New automation can take focus after the last row leaves.
  const [newShown, setNewShown] = useState(false)
  const focusNew = useRef(false)
  // Per mount: a section opened again (after an item) never replays an older delete's focus.
  const followed = useRef(new Map<number, FollowedDelete>())
  const closing = useRef<number | null>(null)

  const follow = (
    opId: number,
    intent: { id: string; rowKey: string },
    viaDialog: boolean
  ): void => {
    followed.current.set(opId, {
      id: intent.id,
      rowKey: intent.rowKey,
      awaitingClose: viaDialog,
      order: openableRowKeys(section.current),
      leftOtherwise: false
    })
  }

  // The next openable row where it was (a row promoted into its place counts), else the one before,
  // else New automation (expanded) or the fold toggle (folded).
  const moveFocusFrom = (entry: FollowedDelete): void => {
    const order = openableRowKeys(section.current)
    const at = entry.order.indexOf(entry.rowKey)
    const before =
      at === -1 ? 0 : entry.order.slice(0, at).filter((key) => order.includes(key)).length
    const next = order[before] ?? order[before - 1]
    const button = next ? rowOpenButton(section.current, next) : null
    if (button) {
      button.focus()
      return
    }
    if (fold.open) {
      focusNew.current = true
      setNewShown(true)
      return
    }
    section.current?.querySelector<HTMLElement>('button[aria-expanded]')?.focus()
  }

  const listedIds = new Set(
    rows.flatMap((row) => (row.kind === 'automation' ? [row.row.automation.id] : []))
  )
  useLayoutEffect(() => {
    const order = openableRowKeys(section.current)
    for (const [opId, entry] of followed.current) {
      const present = order.includes(entry.rowKey)
      const ended = !deletion.pendingOpIds.has(opId)
      if (present) {
        entry.order = order
      } else if (!ended && listedIds.has(entry.id)) {
        // Still listed while its delete runs: it left with a fold, cap or reorder, not the delete.
        entry.leftOtherwise = true
      }
      if (!ended || entry.awaitingClose) {
        continue
      }
      followed.current.delete(opId)
      if (!present && !entry.leftOtherwise && focusIsLost()) {
        moveFocusFrom(entry)
      }
    }
    if (focusNew.current && newShown) {
      focusNew.current = false
      newButton.current?.focus()
      // Never left on the page body: the fold toggle stands in when New automation can't take it.
      if (document.activeElement !== newButton.current) {
        section.current?.querySelector<HTMLElement>('button[aria-expanded]')?.focus()
      }
    }
  })

  const confirmCloseFocus = (event: Event): void => {
    const opId = closing.current
    closing.current = null
    const entry = opId === null ? undefined : followed.current.get(opId)
    if (opId === null || !entry) {
      return
    }
    // The confirmation hands focus to the row it deleted, not back to the menu that opened it.
    event.preventDefault()
    entry.awaitingClose = false
    const button = rowOpenButton(section.current, entry.rowKey)
    if (document.activeElement !== button && !focusIsLost()) {
      return
    }
    if (button) {
      button.focus()
      return
    }
    if (!deletion.pendingOpIds.has(opId)) {
      followed.current.delete(opId)
      if (!entry.leftOtherwise) {
        moveFocusFrom(entry)
      }
    }
  }

  const request = (row: BotAutomationCardRow, asTrouble: boolean): void => {
    if (row.kind !== 'automation' || !deletion.authority) {
      return
    }
    const intent = {
      botKey: deletion.botKey,
      generation: deletion.generation,
      id: row.row.automation.id,
      name: row.row.automation.name,
      authority: deletion.authority,
      admittedAsTrouble: asTrouble,
      rowKey: row.key
    }
    if (useAppStore.getState().settings?.skipDeleteAutomationConfirm) {
      const opId = deletion.admit(intent)
      if (opId !== null) {
        follow(opId, intent, false)
      }
      return
    }
    setDontAskAgain(false)
    setTarget(intent)
  }

  const confirm = (): void => {
    if (!target) {
      return
    }
    // Admission first: an offline host or a delete already running starts nothing, preference included.
    const opId = deletion.admit(target)
    if (opId === null) {
      return
    }
    if (dontAskAgain) {
      const store = useAppStore.getState()
      persistSkipDeleteAutomationConfirm({
        updateSettings: store.updateSettings,
        openSettingsPage: store.openSettingsPage,
        openSettingsTarget: store.openSettingsTarget
      })
    }
    follow(opId, target, true)
    closing.current = opId
    setTarget(null)
    setDontAskAgain(false)
  }

  const rowDeletion = (row: BotAutomationCardRow): BotAutomationRowDeletion | null => {
    if (row.kind !== 'automation') {
      return null
    }
    const pending = deletion.pending.get(row.row.automation.id)
    return {
      pending: Boolean(pending),
      admittedAsTrouble: pending?.admittedAsTrouble ?? false,
      disabled: Boolean(pending) || deletion.offline || !deletion.authority,
      request: (asTrouble) => request(row, asTrouble)
    }
  }

  const item = (row: BotAutomationCardRow, folded: boolean): React.JSX.Element => (
    <UpcomingItem
      key={row.key}
      bot={bot}
      row={row}
      upNext={upNext}
      signInStops={signInStops}
      now={now}
      folded={folded}
      deletion={rowDeletion(row)}
    />
  )
  return (
    <>
      <BotPanelSection
        ref={section}
        title={t('bots.automations.title', 'Automations')}
        fold={fold}
        folded={foldedRows.map((row) => item(row, true))}
        actionsShown={newShown}
        actions={
          // Icon-only, like the Bots header's "+": the tooltip and accessible name carry the label.
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                ref={newButton}
                variant="ghost"
                size="icon-xs"
                aria-label={newLabel}
                onBlur={() => setNewShown(false)}
                onClick={() =>
                  void openBotHomeTab(bot, {
                    draft: t('bots.automations.newDraft', 'Set up an automation that ')
                  })
                }
              >
                <Plus />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              {newLabel}
            </TooltipContent>
          </Tooltip>
        }
      >
        {shown.map((row) => item(row, false))}
        {listed > AUTOMATION_CARD_CAP ? (
          <button
            type="button"
            className="flex min-h-7 w-full items-center justify-between gap-2 rounded-sm pr-2 pl-8 text-left text-xs text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            onClick={() => useAppStore.getState().openAutomationsPage()}
          >
            <span className="min-w-0 truncate">
              {t('bots.automations.all', 'All {{count}} automations', { count: listed })}
              {listedPaused > 0
                ? ` · ${t('bots.automations.pausedCount', '{{count}} paused', { count: listedPaused })}`
                : null}
            </span>
            <ChevronRight className="size-3.5 shrink-0" />
          </button>
        ) : null}
        {hasAutomations ? null : (
          <p className="py-1 pr-2 pl-8 text-xs text-muted-foreground">
            {t(
              'bots.upcoming.empty',
              'Ask {{name}} in chat to run something on a schedule or when something happens.',
              { name: bot.name }
            )}
          </p>
        )}
      </BotPanelSection>
      <AutomationDeleteDialog
        deleteTarget={target?.generation === deletion.generation ? target : null}
        dontAskDeleteAgain={dontAskAgain}
        confirmButtonRef={confirmButton}
        onOpenChange={(open) => {
          if (!open) {
            setTarget(null)
          }
        }}
        onDontAskAgainToggle={() => setDontAskAgain((value) => !value)}
        onCancel={() => setTarget(null)}
        onConfirm={confirm}
        onCloseAutoFocus={confirmCloseFocus}
        confirmDisabledReason={
          deletion.offline
            ? t('bots.upNext.hostOffline', '{{bot}}’s computer is offline', { bot: bot.name })
            : null
        }
      />
    </>
  )
}
