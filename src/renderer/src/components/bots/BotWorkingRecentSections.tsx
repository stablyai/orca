// Working on and Recent, as a host without the chats read (an older paired server) still shows them.
import React from 'react'
import { AgentStateDot, type AgentDotState } from '@/components/agent/status/AgentStateDot'
import { botTarget } from '@/lib/bot-hosts'
import { translate } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import { sessionWorkerIsRunning } from '../../../../shared/orchestration-session-workers'
import { WorkerActivityRow } from './WorkerActivityRow'
import { botWorkerRowOpener } from './bot-worker-open'
import { ActivityRow } from './ActivitySection'
import { BotPanelCard } from './BotPanelCard'

import {
  formatAutomationDateTime,
  getAutomationRunStatusLabel
} from '../automations/automation-page-parts'
import type { Bot } from '../../../../shared/bot-types'
import { CONNECTOR_SOURCE_NAMES } from '../../../../shared/connectors/external-conversation-link'
import { folderWorkspaceKey } from '../../../../shared/workspace/identity/workspace-scope'
import {
  automationRunDot,
  type BotActivityOrigin,
  type BotRunRow,
  type BotSessionActivityRow,
  type BotThreadRow,
  type BotWorkerRow
} from '../../../../shared/bots/bot-activity-model'
import { openBotHomeTab } from '@/lib/bot-catalog'
import { openBotSession } from './bot-session-open'
import { Button } from '@/components/ui/button'
import { openAgentSessionHistoryModal } from '../right-sidebar/ai-vault/panel/agent-session-history-modal'
import { structuredAgentSessionTabId } from '../../../../shared/agent-session/view/structured-agent-session-projection'
import type { BotWork } from '../../../../shared/bots/bot-now'
import { openBotAutomation } from './bot-automation-open'

function originLabel(origin: BotActivityOrigin): string {
  switch (origin.kind) {
    case 'chat':
      return translate('bots.activity.startedByChat', 'Started by your chat')
    case 'thread':
      return translate('bots.activity.startedByThread', 'Started by a {{source}} thread', {
        source: CONNECTOR_SOURCE_NAMES[origin.source]
      })
    case 'automation':
      return translate('bots.activity.startedByAutomation', 'Started by automation {{name}}', {
        name: origin.name
      })
    case 'session':
      return translate('bots.activity.startedInSession', 'Started in {{name}}', {
        name: origin.label
      })
  }
}

function runDotState(row: BotRunRow): AgentDotState {
  return row.dot ?? automationRunDot(row.status)
}

function BotWorkerActivityRow({ bot, row }: { bot: Bot; row: BotWorkerRow }): React.JSX.Element {
  const workspaceId = row.workspaceId
  const recorded = row.worker
  return (
    <WorkerActivityRow
      dispatchId={row.dispatchId}
      title={row.title}
      dot={row.dot}
      running={row.worker ? sessionWorkerIsRunning(row.worker) : row.dot !== 'done'}
      origin={originLabel(row.origin)}
      coordinator={bot.name}
      workspaceId={workspaceId}
      worker={recorded}
      // An agent in a handed workspace is no Dispatch to stop.
      canStop={row.dispatchId !== ''}
      onOpen={botWorkerRowOpener(row, botTarget(bot)) ?? undefined}
    />
  )
}

function ThreadActivityRow({ bot, row }: { bot: Bot; row: BotThreadRow }): React.JSX.Element {
  const t = useTranslate()
  const thread = t('bots.activity.thread', '{{source}} thread', {
    source: CONNECTOR_SOURCE_NAMES[row.source]
  })
  return (
    <ActivityRow
      icon={<AgentStateDot state={row.dot} />}
      title={row.title || thread}
      detail={thread}
      onOpen={() => openBotSession(bot, row.sessionId)}
    />
  )
}

function RunActivityRow({ bot, row }: { bot: Bot; row: BotRunRow }): React.JSX.Element {
  const t = useTranslate()
  const status = row.status === 'completed' ? null : getAutomationRunStatusLabel(row.status)
  return (
    <ActivityRow
      icon={<AgentStateDot state={runDotState(row)} />}
      title={row.automationName}
      detail={[t('bots.activity.run', 'Run'), formatAutomationDateTime(row.at), status]
        .filter(Boolean)
        .join(' · ')}
      onOpen={() =>
        row.sessionId
          ? openBotSession(bot, row.sessionId)
          : openBotAutomation(row.automationId, row.runId)
      }
    />
  )
}

function renderRow(bot: Bot, row: BotSessionActivityRow): React.JSX.Element {
  switch (row.kind) {
    case 'worker':
      return <BotWorkerActivityRow key={row.key} bot={bot} row={row} />
    case 'run':
      return <RunActivityRow key={row.key} bot={bot} row={row} />
    case 'thread':
      return <ThreadActivityRow key={row.key} bot={bot} row={row} />
  }
}

/** The right sidebar's Activity panel: a bot's header and Activity list, or the focused chat's workers. */
export function BotWorkingSection({
  bot,
  work
}: {
  bot: Bot
  work: readonly BotWork[]
}): React.JSX.Element | null {
  const t = useTranslate()
  if (work.length === 0) {
    return null
  }
  return (
    <BotPanelCard title={t('bots.working.title', 'Working on')} count={work.length}>
      {work.map((item) =>
        item.kind === 'chat' ? (
          <ActivityRow
            key={item.key}
            icon={<AgentStateDot state="working" />}
            title={t('bots.needs.chat', 'Your chat with {{name}}', { name: bot.name })}
            detail={t('bots.working.replying', 'Replying')}
            onOpen={() => void openBotHomeTab(bot)}
          />
        ) : (
          renderRow(bot, item.row)
        )
      )}
    </BotPanelCard>
  )
}

const RECENT_LIMIT = 3

/** The last few finished things; See all opens the bot's whole Session History. */
export function BotRecentSection({
  bot,
  completed
}: {
  bot: Bot
  completed: readonly BotSessionActivityRow[]
}): React.JSX.Element | null {
  const t = useTranslate()
  const chatSessionId = bot.chatSessionId
  if (completed.length === 0) {
    return null
  }
  return (
    <BotPanelCard
      title={t('bots.recent.title', 'Recent')}
      action={
        chatSessionId ? (
          <Button
            variant="ghost"
            size="xs"
            onClick={() =>
              openAgentSessionHistoryModal({
                workspace: { worktreeId: folderWorkspaceKey(bot.folderWorkspaceId) },
                chatTabId: structuredAgentSessionTabId(chatSessionId),
                initialQuery: '',
                alongside: true
              })
            }
          >
            {t('bots.recent.seeAll', 'See all')}
          </Button>
        ) : null
      }
    >
      {completed.slice(0, RECENT_LIMIT).map((row) => renderRow(bot, row))}
    </BotPanelCard>
  )
}
