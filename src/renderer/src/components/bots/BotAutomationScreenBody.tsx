// The Automation screen below its crumb: header, one notice, Recent runs, When, Results,
// Instructions and Setup, each built from the Automations page's own pieces.
import { useRuntimeEnvironmentCapability } from '@/runtime/rpc/compatibility/use-runtime-environment-capability'
import { AUTOMATION_UPDATE_GUARD_RUNTIME_CAPABILITY } from '../../../../shared/automations/automation-runtime-capabilities'
import React, { useRef, useState } from 'react'
import { BotAutomationRunAgainDialog } from './BotAutomationRunAgainDialog'
import { toast } from 'sonner'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { openBotAutomation } from './bot-automation-open'
import { useTranslate } from '@/i18n/use-translate'
import { useBotWebhooks } from '@/lib/bot-catalog'
import { useBotHostOffline } from '@/lib/bot-host-views'
import { useAppStore } from '@/store'
import { useNow } from '@/lib/window-activity/use-now'
import type { Bot } from '../../../../shared/bot-types'
import type { AutomationOwnerRef } from '../../../../shared/automations/ownership/automation-owner-ref'
import { hasAutomationSchedule } from '../../../../shared/automation-event-triggers'
import {
  getToneForAutomationRunStatus,
  indexLatestAutomationRuns
} from '../../../../shared/automation-last-run'
import { AutomationDeleteDialog } from '../automations/authoring/AutomationDeleteDialogs'
import { persistSkipDeleteAutomationConfirm } from '../automations/authoring/automation-delete-confirm-preference'
import {
  AutomationDetailHeader,
  type AutomationControlState
} from '../automations/details/AutomationDetailHeader'
import {
  AutomationDetailNotices,
  automationDetailNotices
} from '../automations/details/automation-detail-sections'
import { BotAutomationInstructions } from './BotAutomationInstructions'
import { automationWontFire } from '../automations/details/automation-wont-fire'
import type { AutomationDetailsController } from '../automations/details/automation-details-controller'
import {
  automationActionOutcomeUnknown,
  type AutomationDetailsSnapshot
} from '../automations/details/automation-details-model'
import {
  deleteAutomationForOwner,
  runAutomationNowForOwner,
  updateAutomationForOwner
} from '../automations/hosts/automation-scoped-list-client'
import { AutomationHostScopeUnsupportedError } from '../automations/hosts/automation-capability-probe'
import type { Automation } from '../../../../shared/automations/automation-definition'
import type { BotAutomationPlace } from './bot-automation-place'
import { botAutomationDraftsFull } from './bot-automation-drafts'
import { botErrorMessage } from './bot-presentation'
import { upcomingAt } from './bot-upcoming-copy'
import { useOrcaCloudSignedOut } from './orca-cloud-signed-out'
import { useBotHostLabel } from './use-bot-host-label'
import {
  BotAutomationResultsSection,
  BotAutomationWhenSection,
  type SectionProps
} from './BotAutomationSections'
import { BotAutomationSetup } from './BotAutomationSetup'
import { BotAutomationRuns, botAutomationRunAction } from './BotAutomationRuns'
import { useBotAutomationNotices, type RunNowAttempt } from './bot-automation-notices'

type BodyProps = {
  bot: Bot
  owner: AutomationOwnerRef
  snapshot: AutomationDetailsSnapshot
  controller: AutomationDetailsController
  place: BotAutomationPlace
  titleId: string
  screenKey: string
  editing: SectionProps['editing']
  setEditing: SectionProps['setEditing']
  askInChat: (sentence: string) => Promise<boolean>
  onDeleted: () => void
  onRetired: () => void
}

function statusLine(
  automation: Automation,
  now: number,
  t: ReturnType<typeof useTranslate>
): string {
  if (!automation.enabled) {
    return t('auto.components.automations.enablement.paused', 'Paused')
  }
  if (!hasAutomationSchedule(automation)) {
    return t('bots.automationPanel.onEvents', 'On · Runs on events')
  }
  return t('bots.automationPanel.onNext', 'On · {{when}}', {
    when: upcomingAt(automation.nextRunAt, now)
  })
}

export function BotAutomationScreenBody(props: BodyProps): React.JSX.Element {
  const t = useTranslate()
  const { bot, owner, snapshot, controller, place } = props
  const remoteGuard = useRuntimeEnvironmentCapability(
    owner.authority.kind === 'runtime' ? owner.authority.environmentId : null,
    AUTOMATION_UPDATE_GUARD_RUNTIME_CAPABILITY
  )
  const guardedUpdates = owner.authority.kind === 'desktop' || remoteGuard
  const now = useNow(60_000)
  const offline = useBotHostOffline(bot.hostId)
  const hostLabel = useBotHostLabel(bot.hostId)
  const hostName = hostLabel ?? t('bots.host.thisComputer', 'this computer')
  const settings = useAppStore((state) => state.settings)
  const [runAttempt, setRunNow] = useState<RunNowAttempt>(null)
  const [oldHost, setOldHost] = useState(false)
  const [guardUnsupported, setGuardUnsupported] = useState(false)
  const [deleting, setDeleting] = useState<Automation | null>(null)
  const [dontAskAgain, setDontAskAgain] = useState(false)
  const [announcement, setAnnouncement] = useState('')
  const [savedCount, setSavedCount] = useState(0)
  const [confirmingRun, setConfirmingRun] = useState(false)
  const confirmRef = useRef<HTMLButtonElement>(null)
  const automation = snapshot.definition.value
  const signedOut = useOrcaCloudSignedOut(bot.hostId)
  const webhooks = useBotWebhooks(bot.hostId)
  const wontFire = automation ? automationWontFire(automation, [bot], webhooks, signedOut) : null
  const unsupported =
    oldHost ||
    snapshot.definition.error?.kind === 'unsupported' ||
    snapshot.runs.error?.kind === 'unsupported' ||
    snapshot.selected?.status === 'unsupported'
  const latestRun = automation
    ? indexLatestAutomationRuns(snapshot.runs.value).get(automation.id)
    : undefined
  const running = Boolean(
    (latestRun && getToneForAutomationRunStatus(latestRun.status) === 'running') ||
    (snapshot.acknowledgedRun &&
      getToneForAutomationRunStatus(snapshot.acknowledgedRun.status) === 'running')
  )
  const newManualRun =
    runAttempt?.state === 'unconfirmed'
      ? snapshot.runs.value.find(
          (run) => run.trigger === 'manual' && !runAttempt.knownRunIds.includes(run.id)
        )
      : undefined
  const runNow = newManualRun ? null : runAttempt
  const runningAction =
    latestRun && (!snapshot.acknowledgedRun || latestRun.id === snapshot.acknowledgedRun.id)
      ? botAutomationRunAction(bot, latestRun)
      : null
  const notices = useBotAutomationNotices({
    bot,
    hostName,
    offlineHostName: hostLabel ?? t('bots.automationPanel.thisComputer', 'This computer'),
    snapshot,
    controller,
    offline,
    unsupported: unsupported || !guardedUpdates || guardUnsupported,
    runNow,
    running,
    runningAction: runningAction
      ? {
          onOpen: runningAction.open,
          label:
            runningAction.kind === 'chat'
              ? t('bots.automationPanel.openChat', 'Open chat')
              : t('bots.automationPanel.openTerminal', 'Open terminal')
        }
      : null,
    wontFire,
    draftsFull: botAutomationDraftsFull(props.screenKey) && !props.editing,
    onRetired: props.onRetired,
    onCheckAgain: () => {
      setAnnouncement('')
      void controller.refreshRuns().then((runs) => {
        if (
          !runAttempt ||
          !runs.some((run) => run.trigger === 'manual' && !runAttempt.knownRunIds.includes(run.id))
        ) {
          setAnnouncement(t('bots.automationPanel.stillUnconfirmed', "Still couldn't confirm"))
        }
      })
    },
    onDismissRunNow: () =>
      setRunNow((current) => (current ? { ...current, state: 'dismissed' } : null))
  })
  const blocked: AutomationControlState | null = offline
    ? { unavailable: true, describedBy: notices.ids.offline }
    : snapshot.continuity !== 'same'
      ? { unavailable: true, describedBy: notices.ids.checking }
      : null
  const foreign = Boolean(automation?.bot && automation.bot.botId !== bot.id)

  const fail = (error: unknown): void => {
    if (error instanceof AutomationHostScopeUnsupportedError) {
      setOldHost(true)
      return
    }
    toast.error(botErrorMessage(error))
  }
  const toggle = (current: Automation): void => {
    void controller
      .mutate(
        (o) => updateAutomationForOwner(o, current.id, { enabled: !current.enabled }),
        (next) => next
      )
      .catch(fail)
  }
  const startRun = (current: Automation): void => {
    const knownRunIds = snapshot.runs.value.map((run) => run.id)
    setAnnouncement('')
    setRunNow({ state: 'starting', knownRunIds })
    void controller
      .startRun((o) => runAutomationNowForOwner(o, current.id))
      .then(() => {
        setRunNow(null)
        setAnnouncement(t('bots.automationPanel.runStarted', 'Run started'))
      })
      .catch((error: unknown) => {
        if (automationActionOutcomeUnknown(error)) {
          setRunNow({ state: 'unconfirmed', knownRunIds })
          return
        }
        setRunNow(null)
        fail(error)
      })
  }
  const remove = (current: Automation): void => {
    void controller
      .mutate(
        (o) => deleteAutomationForOwner(o, current.id),
        () => 'deleted'
      )
      .then(() => {
        toast.message(t('bots.automationPanel.deleted', 'Deleted {{name}}', { name: current.name }))
        props.onDeleted()
      })
      .catch(fail)
  }

  if (!automation) {
    return (
      <>
        <AutomationDetailNotices notices={notices.list} limit={1} />
        {snapshot.definition.status === 'loading' ? (
          <p role="status" className="px-2 text-sm text-muted-foreground">
            {t('components.native-chat.automationSaved.loading', 'Loading')}
          </p>
        ) : null}
      </>
    )
  }

  const hostActions: AutomationControlState | null =
    blocked ?? (foreign ? { unavailable: true, describedBy: notices.ids.foreign } : null)
  const editState: AutomationControlState =
    hostActions ??
    (unsupported || !guardedUpdates || guardUnsupported
      ? { unavailable: true, describedBy: notices.ids.oldHost }
      : botAutomationDraftsFull(props.screenKey) && !props.editing
        ? { unavailable: true, describedBy: notices.ids.draftsFull }
        : {})
  const sectionProps: SectionProps = {
    bot,
    automation,
    owner,
    controller,
    screenKey: props.screenKey,
    editing: props.editing,
    setEditing: props.setEditing,
    editState,
    onSaved: () => setSavedCount((count) => count + 1),
    onUnsupported: () => setGuardUnsupported(true),
    askInChat: (sentence) => void props.askInChat(sentence)
  }
  return (
    <>
      <p role="status" aria-live="polite" className="sr-only">
        {newManualRun ? t('bots.automationPanel.runStarted', 'Run started') : announcement}
      </p>
      <p role="status" aria-live="polite" className="sr-only">
        <span key={savedCount}>
          {savedCount > 0 ? t('bots.automationPanel.saved', 'Saved') : ''}
        </span>
      </p>
      <AutomationDetailHeader
        automation={automation}
        titleId={props.titleId}
        subtitle={statusLine(automation, now, t)}
        onRunNow={(current) =>
          runNow?.state === 'dismissed' ? setConfirmingRun(true) : startRun(current)
        }
        runNowLabel={
          running
            ? t('bots.automationPanel.running', 'Running…')
            : runNow?.state === 'dismissed'
              ? t('bots.automationPanel.runAgain', 'Run again…')
              : undefined
        }
        onToggle={toggle}
        onDelete={(current) =>
          settings?.skipDeleteAutomationConfirm ? remove(current) : setDeleting(current)
        }
        runNowState={
          hostActions ??
          (runNow?.state === 'starting'
            ? { pending: true }
            : running
              ? { unavailable: true, describedBy: notices.ids.running }
              : runNow?.state === 'unconfirmed'
                ? { unavailable: true, describedBy: notices.ids.unconfirmed }
                : unsupported
                  ? { unavailable: true, describedBy: notices.ids.oldHost }
                  : snapshot.mutating
                    ? { pending: true }
                    : undefined)
        }
        toggleState={hostActions ?? (snapshot.mutating ? { pending: true } : undefined)}
        deleteState={hostActions ?? (snapshot.mutating ? { pending: true } : undefined)}
        menuItems={
          <>
            <DropdownMenuItem
              onSelect={() =>
                openBotAutomation({
                  bot,
                  automationId: automation.id,
                  hostId: bot.hostId,
                  runId: null,
                  intent: 'page'
                })
              }
            >
              {t('bots.automationPanel.openOnPage', 'Open in Automations')}{' '}
              <span aria-hidden="true">↗</span>
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => void window.api.ui.writeClipboardText(automation.prompt)}
            >
              {t(
                'auto.components.automations.AutomationPromptDisclosure.copyInstructions',
                'Copy instructions'
              )}
            </DropdownMenuItem>
          </>
        }
      />
      <AutomationDetailNotices
        notices={[
          ...automationDetailNotices({
            automation,
            latestRun,
            runNowAvailability: null,
            needsMigration: false,
            t
          }),
          ...notices.list
        ]}
        limit={1}
      />
      {unsupported ? null : (
        <BotAutomationRuns
          bot={bot}
          automation={automation}
          snapshot={snapshot}
          controller={controller}
          initialRunId={place.runId}
          now={now}
        />
      )}
      <BotAutomationWhenSection {...sectionProps} />
      <BotAutomationResultsSection {...sectionProps} />
      <BotAutomationInstructions
        automation={automation}
        botName={bot.name}
        askInChat={props.askInChat}
      />
      <BotAutomationSetup automation={automation} hostName={hostName} botName={bot.name} />
      <BotAutomationRunAgainDialog
        open={confirmingRun}
        onClose={() => setConfirmingRun(false)}
        onConfirm={() => {
          setConfirmingRun(false)
          startRun(automation)
        }}
      />
      <AutomationDeleteDialog
        deleteTarget={deleting}
        dontAskDeleteAgain={dontAskAgain}
        confirmButtonRef={confirmRef}
        initialFocus="cancel"
        onOpenChange={(open) => (open ? undefined : setDeleting(null))}
        onDontAskAgainToggle={() => setDontAskAgain(!dontAskAgain)}
        onCancel={() => setDeleting(null)}
        onConfirm={() => {
          const target = deleting
          setDeleting(null)
          if (dontAskAgain) {
            const state = useAppStore.getState()
            persistSkipDeleteAutomationConfirm({
              updateSettings: state.updateSettings,
              openSettingsPage: state.openSettingsPage,
              openSettingsTarget: state.openSettingsTarget
            })
          }
          if (target) {
            remove(target)
          }
        }}
      />
    </>
  )
}
