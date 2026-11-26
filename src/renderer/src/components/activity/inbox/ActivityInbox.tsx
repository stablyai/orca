// Activity with the app rail on: an inbox of what is addressed to you, never a monitor of what is running.
import React, { useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslate } from '@/i18n/use-translate'
import { AgentTypeIcon } from '@/components/agent/icons/agent-type-icon'
import { AgentStateDot } from '@/components/agent/status/AgentStateDot'
import { useAllAgentPaneThreads } from '../threads/use-agent-pane-threads'
import {
  activityThreadRowCopy,
  activityThreadStatusId,
  threadAgentStateLabel
} from '../threads/activity-thread-presentation'
import { useActivityThreadActionBindings } from '../thread-list/use-activity-thread-action-bindings'
import type { AgentPaneThread } from '../threads/activity-thread-types'
import { activityInboxKind } from './activity-inbox'
import { ActivityInboxBotRows, useActivityInboxBotEntries } from './ActivityInboxBotRows'
import { ActivityInboxEmpty } from './ActivityInboxEmpty'
import { ActivityInboxMarkAllRead } from './ActivityInboxMarkAllRead'
import { ActivityInboxRow, ActivityInboxSectionHeader } from './ActivityInboxRow'

// Rows show one plain line; inline code and bold markers would otherwise print as literal characters.
const plainLine = (line: string): string => line.replace(/`|\*\*/g, '')

const newestFirst = (a: AgentPaneThread, b: AgentPaneThread): number =>
  b.latestTimestamp - a.latestTimestamp

/**
 * Needs you: agents waiting on you, bots with tasks for you, access requests. New: finished turns you haven't read.
 * Opening a finished row reads it; it stays until you leave Activity, so the row you clicked never vanishes.
 */
export default function ActivityInbox({
  actionsTarget
}: {
  actionsTarget?: HTMLElement | null
}): React.JSX.Element {
  const t = useTranslate()
  const { storeData, allThreads } = useAllAgentPaneThreads()
  const botEntries = useActivityInboxBotEntries()
  const [openedPaneKey, setOpenedPaneKey] = useState<string | null>(null)

  const { asks, outcomes } = useMemo(() => {
    const nextAsks: AgentPaneThread[] = []
    const nextOutcomes: AgentPaneThread[] = []
    for (const thread of allThreads) {
      const kind = activityInboxKind(thread)
      if (kind === 'ask') {
        nextAsks.push(thread)
      } else if (kind === 'outcome' && (thread.unread || thread.paneKey === openedPaneKey)) {
        nextOutcomes.push(thread)
      }
    }
    return { asks: nextAsks.sort(newestFirst), outcomes: nextOutcomes.sort(newestFirst) }
  }, [allThreads, openedPaneKey])
  const listed = useMemo(() => [...asks, ...outcomes], [asks, outcomes])

  const { selectThread, markAllThreadsRead, hasUnreadThreads } = useActivityThreadActionBindings({
    visibleThreads: listed,
    markAllReadThreads: listed,
    acknowledgeAgents: storeData.acknowledgeAgents,
    unacknowledgeAgents: storeData.unacknowledgeAgents,
    setSelectedPaneKey: setOpenedPaneKey
  })

  const needsYouCount = asks.length + botEntries.bots.length + botEntries.requests.length
  const actions = actionsTarget
    ? createPortal(
        <ActivityInboxMarkAllRead
          disabled={!hasUnreadThreads}
          onMarkAllRead={markAllThreadsRead}
        />,
        actionsTarget
      )
    : null

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-1.5 pb-2 scrollbar-sleek">
      {actions}
      {needsYouCount === 0 && outcomes.length === 0 ? <ActivityInboxEmpty /> : null}
      {needsYouCount > 0 ? (
        <section aria-label={t('activityInbox.needsYou', 'Needs you')}>
          <ActivityInboxSectionHeader
            label={t('activityInbox.needsYou', 'Needs you')}
            state="waiting"
            count={needsYouCount}
          />
          <ul>
            {asks.map((thread) => (
              <AgentInboxRow key={thread.paneKey} thread={thread} ask onOpen={selectThread} />
            ))}
            <ActivityInboxBotRows {...botEntries} />
          </ul>
        </section>
      ) : null}
      {outcomes.length > 0 ? (
        <section aria-label={t('activityInbox.new', 'New')} className="pt-1">
          <ActivityInboxSectionHeader
            label={t('activityInbox.new', 'New')}
            state="done"
            count={outcomes.length}
          />
          <ul>
            {outcomes.map((thread) => (
              <AgentInboxRow
                key={thread.paneKey}
                thread={thread}
                ask={false}
                onOpen={selectThread}
              />
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  )
}

export const AgentInboxRow = React.memo(function AgentInboxRow({
  thread,
  ask,
  onOpen
}: {
  thread: AgentPaneThread
  ask: boolean
  onOpen: (thread: AgentPaneThread) => void
}): React.JSX.Element {
  const t = useTranslate()
  const { taskTitle, statusLine, workspaceLabel } = activityThreadRowCopy(thread, t)
  const status = activityThreadStatusId(thread)
  return (
    <ActivityInboxRow
      avatar={<AgentTypeIcon agentType={thread.agentType} size={14} />}
      title={taskTitle}
      timestamp={thread.latestTimestamp}
      line={statusLine === null ? null : plainLine(statusLine)}
      ask={ask}
      contextIcon={<AgentStateDot state={status} size="sm" />}
      context={`${threadAgentStateLabel(thread, t)} · ${workspaceLabel}`}
      onOpen={() => onOpen(thread)}
    />
  )
})
