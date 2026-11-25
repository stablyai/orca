// Recent runs on the Automation screen: the shared compact run list, rows expanding in place, an
// asked-for older run pinned at the top, and Show more until the page takes over.
import React from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { botErrorMessage } from './bot-presentation'
import { actOnBotAutomationRow } from '../automations/hosts/bot-automation-row-owner'
import { automationOwnerForHostId } from '../automations/hosts/automation-host-owner'
import type { AutomationOwnerRef } from '../../../../shared/automations/ownership/automation-owner-ref'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { translate } from '@/i18n/i18n'
import { revealWorkerPane } from '@/lib/open-orchestration-worker'
import { parseExecutionHostId } from '../../../../shared/execution-host/execution-host'
import type { Automation } from '../../../../shared/automations/automation-definition'
import type { AutomationRun } from '../../../../shared/automations/history/automation-run'
import type { Bot } from '../../../../shared/bot-types'
import { AutomationRecentRunList } from '../automations/runs/AutomationRecentRunList'
import { DetailSection } from '../automations/details/automation-detail-sections'
import type { AutomationDetailsController } from '../automations/details/automation-details-controller'
import {
  acknowledgedAutomationRun,
  type AutomationDetailsSnapshot
} from '../automations/details/automation-details-model'
import { openBotAutomation } from './bot-automation-open'
import { openBotSession } from './bot-session-open'

const LINK =
  'min-h-6 inline-flex items-center rounded-sm text-xs text-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'

export function botAutomationRunAction(
  bot: Bot,
  run: AutomationRun,
  owner: AutomationOwnerRef
): { kind: 'chat' | 'terminal'; open: () => void } | null {
  const guarded =
    (open: () => void): (() => void) =>
    () => {
      void actOnBotAutomationRow(owner, async (current) => {
        const target = automationOwnerForHostId(bot.hostId, useAppStore.getState())
        if (!target || JSON.stringify(target) !== JSON.stringify(current)) {
          throw new Error(
            translate(
              'bots.automationPanel.refreshBeforeOpen',
              'This computer changed. Refresh this automation before opening it.'
            )
          )
        }
        open()
      }).catch((error: unknown) => toast.error(botErrorMessage(error)))
    }
  if (run.sessionKind === 'chat' && run.chatSessionId) {
    return {
      kind: 'chat',
      open: guarded(() => openBotSession(bot, run.chatSessionId ?? '', run.workspaceId))
    }
  }
  if (run.terminalPaneKey && run.workspaceId) {
    const host = parseExecutionHostId(bot.hostId)
    return {
      kind: 'terminal',
      open: guarded(() =>
        revealWorkerPane(
          run.workspaceId ?? '',
          run.terminalPaneKey,
          host?.kind === 'runtime' ? host.id : undefined
        )
      )
    }
  }
  return null
}

export function RunActions({
  bot,
  run,
  owner
}: {
  bot: Bot
  run: AutomationRun
  owner: AutomationOwnerRef
}): React.JSX.Element | null {
  const t = useTranslate()
  const action = botAutomationRunAction(bot, run, owner)
  return action ? (
    <button type="button" className={LINK} onClick={action.open}>
      {action.kind === 'chat'
        ? t('bots.automationPanel.openChat', 'Open chat')
        : t('bots.automationPanel.openTerminal', 'Open terminal')}
    </button>
  ) : null
}

export function BotAutomationRuns({
  bot,
  automation,
  snapshot,
  controller,
  now
}: {
  bot: Bot
  automation: Pick<Automation, 'id'>
  snapshot: AutomationDetailsSnapshot
  controller: AutomationDetailsController
  now: number
}): React.JSX.Element {
  const t = useTranslate()
  const { runs, selected } = snapshot
  const receipt = acknowledgedAutomationRun(snapshot, automation.id)
  const shownRuns = receipt ? [receipt, ...runs.value] : runs.value
  const pinnedRun =
    selected?.run && !runs.value.some((run) => run.id === selected.runId) ? selected.run : null
  const toPage = (runId: string | null): void =>
    openBotAutomation({
      bot,
      automationId: automation.id,
      runId,
      owner: snapshot.owner,
      intent: 'page'
    })
  const selectedNote =
    selected && selected.status !== 'in-window' && selected.status !== 'ready'
      ? selected.status === 'loading'
        ? t('bots.automationPanel.runLoading', 'Reading that run…')
        : selected.status === 'run-missing'
          ? t('bots.automationPanel.runGone', 'That run is no longer kept.')
          : selected.status === 'unsupported'
            ? t('bots.automationPanel.runUnsupported', "Can't open that run here.")
            : (selected.error?.message ??
              t('bots.automationPanel.runFailed', "Couldn't read that run."))
      : null
  return (
    <DetailSection title={t('components.native-chat.automationSaved.recentRuns', 'Recent runs')}>
      <div className="flex min-w-0 flex-col gap-1 px-2 py-2">
        {selectedNote ? (
          <p
            role="status"
            className="flex flex-wrap items-center gap-2 px-2 text-xs text-muted-foreground"
          >
            {selectedNote}
            {selected?.status === 'error' ? (
              <button type="button" className={LINK} onClick={() => controller.retrySelected()}>
                {t('bots.automationPanel.retry', 'Retry')}
              </button>
            ) : selected?.status === 'unsupported' ? (
              <button type="button" className={LINK} onClick={() => toPage(selected.runId)}>
                {t('bots.automationPanel.openOnPage', 'Open in Automations')}{' '}
                <span aria-hidden="true">↗</span>
              </button>
            ) : null}
          </p>
        ) : null}
        {runs.status === 'loading' ? (
          <p role="status" className="px-2 text-xs text-muted-foreground">
            {t('auto.components.automations.AutomationRunsDashboard.loading', 'Loading runs…')}
          </p>
        ) : runs.status === 'error' && !pinnedRun && !receipt ? (
          <p className="flex flex-wrap items-center gap-2 px-2 text-xs text-muted-foreground">
            {t('bots.automationPanel.runsFailed', "Couldn't read its runs.")}
            <button type="button" className={LINK} onClick={() => controller.reload()}>
              {t('bots.automationPanel.retry', 'Retry')}
            </button>
          </p>
        ) : shownRuns.length === 0 && !pinnedRun ? (
          <p className="px-2 text-xs text-muted-foreground">
            {t('components.native-chat.automationSaved.noRuns', 'No runs yet')}
          </p>
        ) : (
          <AutomationRecentRunList
            ariaLabel={t('components.native-chat.automationSaved.recentRuns', 'Recent runs')}
            runs={shownRuns}
            now={now}
            pinned={
              pinnedRun
                ? {
                    run: pinnedRun,
                    label: t('bots.automationPanel.openedRun', 'Opened run')
                  }
                : null
            }
            expandedRunId={snapshot.expandedRunId ?? null}
            onPress={(run) => controller.toggleRun(run.id)}
            renderActions={(run) => (
              <>
                <RunActions bot={bot} run={run} owner={snapshot.owner} />
                {run.outputSnapshot?.truncated ? (
                  <button type="button" className={LINK} onClick={() => toPage(run.id)}>
                    {t('bots.automationPanel.fullOutput', 'Full output')}{' '}
                    <span aria-hidden="true">↗</span>
                  </button>
                ) : null}
              </>
            )}
          />
        )}
        {runs.error && runs.status !== 'error' ? (
          <p className="px-2 text-2xs text-muted-foreground">
            {t('bots.automationPanel.runsStale', "Couldn't read newer runs.")}
            <button type="button" className={LINK} onClick={() => void controller.refreshRuns()}>
              {t('bots.automationPanel.retry', 'Retry')}
            </button>
          </p>
        ) : null}
        {runs.olderError ? (
          <p className="px-2 text-2xs text-muted-foreground">
            {t(
              'bots.automationPanel.moreRunsFailed',
              "Couldn't read older runs. Try Show more again."
            )}
          </p>
        ) : null}
        {runs.capacityError ? (
          <p role="status" className="px-2 text-2xs text-muted-foreground">
            {runs.capacityError.message}
          </p>
        ) : null}
        {runs.capped ? (
          <button type="button" className={`${LINK} self-start px-2`} onClick={() => toPage(null)}>
            {t('bots.automationPanel.olderOnPage', 'Older runs are in Automations')}{' '}
            <span aria-hidden="true">↗</span>
          </button>
        ) : runs.nextCursor ? (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="self-start"
            aria-busy={runs.loadingMore || undefined}
            onClick={() => controller.loadMore()}
          >
            {t('bots.automationPanel.showMore', 'Show more')}
          </Button>
        ) : null}
      </div>
    </DetailSection>
  )
}
