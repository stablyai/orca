// Automations in a bot's Activity panel: Tidy memory, Look around, automations and waits, failed first,
// then running, then soonest; paused ones last. Five automations show, then "All N automations", which
// opens the Automations page filtered to this bot. Folded, the rows
// in trouble stay listed under the header. An automation's Delete confirms here and keeps focus near it.
import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { ChevronRight, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import { openBotHomeTab } from '@/lib/bot-catalog'
import { openBotAutomations } from './bot-automation-open'
import { useAppStore } from '@/store'
import type { Bot } from '../../../../shared/bot-types'
import { folderWorkspaceKey } from '../../../../shared/workspace/identity/workspace-scope'
import type { UpNextState } from '../../../../shared/bots/bot-look-around'
import { AutomationDeleteDialog } from '../automations/authoring/AutomationDeleteDialogs'
import { persistSkipDeleteAutomationConfirm } from '../automations/authoring/automation-delete-confirm-preference'
import { BotPanelSection } from './BotPanelSection'
import { useBotPanelFold } from './use-bot-panel-fold'
import {
  AUTOMATION_CARD_CAP,
  botAutomationCardView,
  botAutomationCardRows,
  useAutomationCardOrder,
  type BotAutomationCardRow
} from './bot-automation-card'
import { UpcomingItem, type BotAutomationRowDeletion } from './BotUpcomingRows'
import { isBotRowTrouble } from './BotPanelRow'
import {
  automationEnabled,
  botAutomationMembershipState,
  ownedOverride,
  useBotAutomationMembership,
  type AutomationEnabledOverride,
  type AutomationOverrideOwner,
  type NormalAutomationCardRow
} from './bot-automation-row-membership'
import { botReadAuthorityKey, type BotReadAuthority } from './bot-read-authority'
import type { BotAutomationDeletion } from './use-bot-automation-delete'
import type { BotActivityWithAuthority } from './use-bot-activity'
import {
  useBotAutomationDeleteFocus,
  type BotAutomationFocusIntent
} from './use-bot-automation-delete-focus'

type DeleteTarget = Omit<BotAutomationFocusIntent, 'admittedAsTrouble' | 'saved'>

function overrideOwner(route: {
  generation: symbol
  authority: BotReadAuthority
  rowKey: string
}): AutomationOverrideOwner {
  return {
    generation: route.generation,
    authorityKey: botReadAuthorityKey(route.authority),
    rowKey: route.rowKey
  }
}

export function BotUpcomingSection({
  bot,
  rows,
  hiddenKeys,
  upNext,
  hasAutomations,
  hasConnectorNeed,
  now,
  deletion,
  panelFallback
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
  hasConnectorNeed: boolean
  now: number
  deletion: BotAutomationDeletion
  panelFallback: RefObject<HTMLDivElement | null>
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
  const confirmButton = useRef<HTMLButtonElement | null>(null)
  const [dialogId, setDialogId] = useState(0)
  const [target, setTarget] = useState<DeleteTarget | null>(null)
  const [dontAskAgain, setDontAskAgain] = useState(false)
  const savedByRow = useRef(new Map<string, AutomationEnabledOverride>())
  const commitSaved = useCallback((rowKey: string, saved: AutomationEnabledOverride | null) => {
    if (saved) {
      savedByRow.current.set(rowKey, saved)
    } else {
      savedByRow.current.delete(rowKey)
    }
  }, [])
  const membership = useBotAutomationMembership(bot, hasConnectorNeed)
  const membershipAtCommit = useRef(membership)
  useLayoutEffect(() => {
    membershipAtCommit.current = membership
  }, [membership])
  const hasTrouble = (
    card: NormalAutomationCardRow,
    saved: AutomationEnabledOverride | null,
    owner: AutomationOverrideOwner
  ): boolean => {
    const enabled = automationEnabled(card.row.automation, saved, owner)
    return isBotRowTrouble(
      botAutomationMembershipState(card, membershipAtCommit.current, t, enabled)
    )
  }
  const troubleCleared = (
    intent: BotAutomationFocusIntent,
    cards: readonly BotAutomationCardRow[]
  ): boolean => {
    const card = cards.find((row) => row.key === intent.rowKey)
    return card?.kind === 'automation' && !hasTrouble(card, intent.saved, overrideOwner(intent))
  }
  const { section, newButton, newShown, setNewShown, follow, onCloseAutoFocus } =
    useBotAutomationDeleteFocus({
      deletion,
      open: fold.open,
      panelFallback,
      troubleCleared: (intent) => troubleCleared(intent, rows)
    })
  const admit = (route: DeleteTarget, dialog?: number): boolean => {
    const current = deletion.currentReadFor(route)
    const card =
      current &&
      botAutomationCardRows(bot, current.activity, now).find((row) => row.key === route.rowKey)
    if (card?.kind !== 'automation') {
      return false
    }
    // The route's authority is the current read's, so this is the owner its row shows saves for.
    const owner = overrideOwner(route)
    const saved = ownedOverride(savedByRow.current.get(route.rowKey) ?? null, owner)
    const intent: BotAutomationFocusIntent = {
      ...route,
      saved,
      admittedAsTrouble: hasTrouble(card, saved, owner)
    }
    const admission = deletion.admit(
      intent,
      intent.admittedAsTrouble
        ? (activity: BotActivityWithAuthority['activity']) =>
            troubleCleared(intent, botAutomationCardRows(bot, activity, now))
        : undefined
    )
    if (!admission) {
      return false
    }
    follow(intent, admission, dialog)
    return true
  }

  const request = (row: BotAutomationCardRow): void => {
    if (row.kind !== 'automation' || !deletion.authority) {
      return
    }
    const intent: DeleteTarget = {
      botKey: deletion.botKey,
      generation: deletion.generation,
      id: row.row.automation.id,
      name: row.row.automation.name,
      authority: deletion.authority,
      rowKey: row.key
    }
    if (useAppStore.getState().settings?.skipDeleteAutomationConfirm) {
      admit(intent)
    } else if (deletion.canAdmit(intent)) {
      setDialogId((id) => id + 1)
      setDontAskAgain(false)
      setTarget(intent)
    }
  }

  const confirm = (): void => {
    if (!target) {
      return
    }
    if (!admit(target, dialogId)) {
      if (deletion.membership(target) !== 'listed') {
        setTarget(null)
      }
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
      disabled:
        Boolean(pending) ||
        deletion.offline ||
        !deletion.authority ||
        deletion.authority.kind === 'environment-unavailable',
      request: () => request(row),
      owner: deletion.authority
        ? overrideOwner({
            generation: deletion.generation,
            authority: deletion.authority,
            rowKey: row.key
          })
        : null,
      commitSaved
    }
  }

  const item = (row: BotAutomationCardRow, folded: boolean): React.JSX.Element => (
    <UpcomingItem
      key={row.key}
      membership={membership}
      row={row}
      upNext={upNext}
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
            onClick={() =>
              openBotAutomations({
                workspaceId: folderWorkspaceKey(bot.folderWorkspaceId),
                name: bot.name,
                hostId: bot.hostId
              })
            }
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
        key={dialogId}
        deleteTarget={
          target?.generation === deletion.generation &&
          deletion.authority &&
          botReadAuthorityKey(target.authority) === botReadAuthorityKey(deletion.authority)
            ? target
            : null
        }
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
        onCloseAutoFocus={(event) => onCloseAutoFocus(dialogId, event)}
        confirmDisabledReason={
          deletion.offline
            ? t('bots.upNext.hostOffline', '{{bot}}’s computer is offline', { bot: bot.name })
            : null
        }
      />
    </>
  )
}
