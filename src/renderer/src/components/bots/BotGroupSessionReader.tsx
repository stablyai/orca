import { memo, useEffect, useMemo } from 'react'
import type { RuntimeClientTarget } from '../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { useStructuredAgentSession } from '../native-chat/session/structured/use-structured-agent-session'
import {
  botGroupOperationAdmitted,
  createBotGroupJournalIndexer,
  type BotGroupJournalIndex,
  type BotGroupTurn
} from '../../../../shared/bots/bot-group'
export type BotGroupSession = ReturnType<typeof useStructuredAgentSession> & {
  groupTurnItems: BotGroupJournalIndex['read']
  /** The room operations that only joined a turn another operation opened. */
  joinedTurns: ReadonlySet<string>
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
  const controller = useStructuredAgentSession({
    sessionId: turn.sessionId,
    agent: turn.agent,
    target,
    isVisible: visible,
    queueFollowUps: true
  })
  const indexJournal = useMemo(() => createBotGroupJournalIndexer(), [])
  const journal = useMemo(
    () => ({ items: controller.journalItems, submissions: controller.submissions }),
    [controller.journalItems, controller.submissions]
  )
  const index = useMemo(
    () => indexJournal(journal, turn.operationIds),
    [indexJournal, journal, turn.operationIds]
  )
  const groupTurnItems = index.read
  const joinedTurns = index.joined
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
          // A joined turn has no rows of its own to page for.
          !joinedTurns.has(id) &&
          botGroupOperationAdmitted(journal, id)
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
    joinedTurns,
    journal
  ])
  const session = useMemo(
    () => ({ ...controller, groupTurnItems, joinedTurns }),
    [controller, groupTurnItems, joinedTurns]
  )
  useEffect(() => {
    report(turn.sessionId, session)
  }, [turn.sessionId, report, session])
  useEffect(() => () => report(turn.sessionId, null), [turn.sessionId, report])
  return null
})
