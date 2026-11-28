import { memo, useEffect, useMemo } from 'react'
import type { RuntimeClientTarget } from '../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { useStructuredAgentSession } from '../native-chat/session/structured/use-structured-agent-session'
import { useStructuredAgentSessionActiveProvider } from '../native-chat/session/status/structured-agent-session-status-hooks'
import {
  botGroupOperationAdmitted,
  createBotGroupJournalIndexer,
  type indexBotGroupJournal,
  type BotGroupTurn
} from '../../../../shared/bots/bot-group'
export type BotGroupSession = ReturnType<typeof useStructuredAgentSession> & {
  agent: string
  groupTurnItems: ReturnType<typeof indexBotGroupJournal>
}
export const BotGroupSessionReader = memo(function BotGroupSessionReader({
  target,
  turn,
  visible,
  report
}: {
  /** The group's host, which runs its members' sessions. */
  target: RuntimeClientTarget
  turn: Pick<BotGroupTurn, 'sessionId' | 'agent'> & { operationIds: readonly string[] }
  visible: boolean
  report: (sessionId: string, session: BotGroupSession | null) => void
}): null {
  const activeAgent = useStructuredAgentSessionActiveProvider(turn.sessionId, target, turn.agent)
  const controller = useStructuredAgentSession({
    sessionId: turn.sessionId,
    agent: activeAgent,
    target,
    isVisible: visible,
    queueFollowUps: true
  })
  const indexJournal = useMemo(() => createBotGroupJournalIndexer(), [])
  const groupTurnItems = useMemo(
    () =>
      indexJournal(
        { items: controller.journalItems, submissions: controller.submissions },
        turn.operationIds
      ),
    [indexJournal, controller.journalItems, controller.submissions, turn.operationIds]
  )
  const { readCurrent, hasOlder, loadingOlder, loadOlder } = controller
  useEffect(() => {
    if (
      readCurrent &&
      hasOlder &&
      !loadingOlder &&
      // Page only for a turn the session admitted; queued or refused ones have no older rows to find.
      turn.operationIds.some(
        (id) =>
          groupTurnItems(id).length === 0 &&
          botGroupOperationAdmitted(
            { items: controller.journalItems, submissions: controller.submissions },
            id
          )
      )
    ) {
      void loadOlder()
    }
  }, [
    readCurrent,
    hasOlder,
    loadingOlder,
    loadOlder,
    turn.operationIds,
    groupTurnItems,
    controller.journalItems,
    controller.submissions
  ])
  const session = useMemo(
    () => ({ ...controller, agent: activeAgent, groupTurnItems }),
    [controller, activeAgent, groupTurnItems]
  )
  useEffect(() => {
    report(turn.sessionId, session)
  }, [turn.sessionId, report, session])
  useEffect(() => () => report(turn.sessionId, null), [turn.sessionId, report])
  return null
})
