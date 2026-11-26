import { useTranslate } from '@/i18n/use-translate'
import { useState } from 'react'
import { NativeChatApprovalCard } from '../native-chat/prompts/NativeChatApprovalCard'
import { NativeChatStructuredQuestionCard } from '../native-chat/prompts/NativeChatStructuredQuestionCard'
import { chatApprovalFromJournal } from '../../../../shared/native-chat/input/native-chat-interactive-prompt'
import { agentSessionPromptQuestions } from '../../../../shared/agent-session/requests/prompts/agent-session-question-answer'
import { useStructuredPromptResponseHold } from '../native-chat/prompts/use-structured-prompt-response-hold'
import type { BotGroupSession } from './BotGroupSessionReader'
import type { BotGroup } from '../../../../shared/bots/bot-group'
import { useBots } from '@/lib/bot-catalog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'

export function BotGroupApprovalDock({
  group,
  sessions
}: {
  group: Pick<BotGroup, 'hostId' | 'members'>
  sessions: ReadonlyMap<string, BotGroupSession>
}): React.JSX.Element | null {
  const t = useTranslate()
  const bots = useBots()
  const { members } = group
  // Ids are random per host; the room's members are its own host's bots.
  const memberName = (botId: string): string | undefined =>
    bots.find((bot) => bot.id === botId && bot.hostId === group.hostId)?.name
  const waiting = members.filter((member) => sessions.get(member.sessionId)?.prompts.length)
  const [selected, setSelected] = useState<string | null>(null)
  const member = waiting.find((member) => member.botId === selected) ?? waiting[0]
  const session = member && sessions.get(member.sessionId)
  if (!member || !session) {
    return null
  }
  return (
    <div>
      {waiting.length > 1 ? (
        <div className="mx-auto max-w-3xl px-4">
          <Select value={member.botId} onValueChange={setSelected}>
            <SelectTrigger className="h-8 w-fit">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {waiting.map((member) => (
                <SelectItem key={member.botId} value={member.botId}>
                  {memberName(member.botId)} {t('bots.groups.needsYou', '· Needs you')}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : (
        <div className="mx-auto max-w-3xl px-4 text-xs text-chat-foreground-faint">
          {memberName(member.botId)} {t('bots.groups.needsYou', '· Needs you')}
        </div>
      )}
      <Request key={member.sessionId} session={session} />
    </div>
  )
}
function Request({ session }: { session: BotGroupSession }): React.JSX.Element | null {
  const hold = useStructuredPromptResponseHold(session.respond)
  const prompt = session.prompts[0]
  if (!prompt) {
    return null
  }
  const cancel = () => {
    void session.cancel(session.turnId ?? undefined, {
      itemId: prompt.itemId,
      expectedRevision: prompt.revision
    })
  }
  if (prompt.body.kind === 'approval') {
    return (
      <NativeChatApprovalCard
        approval={chatApprovalFromJournal(prompt.body)}
        onChoose={(optionId) => void hold.respond(prompt, { kind: 'option', optionId })}
        isSubmitting={hold.holds(prompt)}
        onCancel={cancel}
        shouldFocus={false}
      />
    )
  }
  if (prompt.body.kind === 'question') {
    return (
      <NativeChatStructuredQuestionCard
        questions={agentSessionPromptQuestions(prompt.body)}
        onAnswer={(response) => void hold.respond(prompt, response)}
        isSubmitting={hold.holds(prompt)}
        onCancel={cancel}
        shouldFocus={false}
      />
    )
  }
  return null
}
