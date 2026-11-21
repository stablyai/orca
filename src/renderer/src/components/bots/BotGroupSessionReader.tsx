import { memo, useEffect, useMemo } from 'react'
import type { RuntimeClientTarget } from '../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { useStructuredAgentSession } from '../native-chat/session/structured/use-structured-agent-session'
import {
  botGroupOperationAdmitted,
  createBotGroupJournalIndexer,
  type indexBotGroupJournal,
  type BotGroupTurn
} from '../../../../shared/bots/bot-group'
import { botGroupSteeredOperations } from '../../../../shared/bots/bot-group-visible-turns'
export type BotGroupSession = ReturnType<typeof useStructuredAgentSession> & {
  groupTurnItems: ReturnType<typeof indexBotGroupJournal>
  steeredOperations: ReadonlySet<string>
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
        turn.operationIds
      ),
    [indexJournal, controller.journalItems, controller.submissions, turn.operationIds]
  )
  const steeredOperations = useMemo(
    () =>
      botGroupSteeredOperations(
        { items: controller.journalItems, submissions: controller.submissions },
        turn.operationIds
      ),
    [controller.journalItems, controller.submissions, turn.operationIds]
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
    () => ({ ...controller, groupTurnItems, steeredOperations }),
    [controller, groupTurnItems, steeredOperations]
  )
  useEffect(() => {
    report(turn.sessionId, session)
  }, [turn.sessionId, report, session])
  useEffect(() => () => report(turn.sessionId, null), [turn.sessionId, report])
  return null
})
