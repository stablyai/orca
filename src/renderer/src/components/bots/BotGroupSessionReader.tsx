import { memo, useEffect, useMemo } from 'react'
import type { RuntimeClientTarget } from '../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { useStructuredAgentSession } from '../native-chat/session/structured/use-structured-agent-session'
import {
  botGroupTurnNeedsOlderPage,
  createBotGroupJournalIndexer,
  type indexBotGroupJournal,
  type BotGroupTurn
} from '../../../../shared/bots/bot-group'
export type BotGroupSession = ReturnType<typeof useStructuredAgentSession> & {
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
  const controller = useStructuredAgentSession({
    sessionId: turn.sessionId,
    agent: turn.agent,
    target,
    isVisible: visible,
    queueFollowUps: true
  })
  const indexJournal = useMemo(() => createBotGroupJournalIndexer(), [])
  const groupTurnItems = useMemo(
    () =>
      indexJournal(
        { items: controller.journalItems, submissions: controller.submissions },
        turn.operationIds,
        controller.latestTurn
      ),
    [
      indexJournal,
      controller.journalItems,
      controller.submissions,
      turn.operationIds,
      controller.latestTurn
    ]
  )
  const { readCurrent, hasOlder, loadingOlder, loadOlder } = controller
  useEffect(() => {
    const journal = { items: controller.journalItems, submissions: controller.submissions }
    if (
      readCurrent &&
      hasOlder &&
      !loadingOlder &&
      // Page while a running turn still starts above the window, or an admitted turn has no rows.
      turn.operationIds.some((id) => botGroupTurnNeedsOlderPage(journal, id, controller.latestTurn))
    ) {
      void loadOlder()
    }
  }, [
    readCurrent,
    hasOlder,
    loadingOlder,
    loadOlder,
    turn.operationIds,
    controller.journalItems,
    controller.submissions,
    controller.latestTurn
  ])
  const session = useMemo(() => ({ ...controller, groupTurnItems }), [controller, groupTurnItems])
  useEffect(() => {
    report(turn.sessionId, session)
  }, [turn.sessionId, report, session])
  useEffect(() => () => report(turn.sessionId, null), [turn.sessionId, report])
  return null
})
