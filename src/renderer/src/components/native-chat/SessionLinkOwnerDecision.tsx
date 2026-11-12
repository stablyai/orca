import { useState } from 'react'
import type { SessionLink, SessionLinkEvent } from '../../../../shared/session-link'
import type { AskPrompt } from '../../../../shared/native-chat/input/native-chat-ask-types'
import { formatAskAnswer } from '../../../../shared/native-chat/input/native-chat-ask-answer'
import { tuiAgentDisplayName } from '../../../../shared/agent-launch/catalog/tui-agent-display-names'
import { useTranslate } from '@/i18n/use-translate'
import { SecuritySurface } from '@/components/ui/security-surface'
import { NativeChatQuestionCard } from './prompts/NativeChatQuestionCard'
import { NativeChatPromptStrip } from './prompts/NativeChatPromptCollapse'

export function SessionLinkOwnerDecision({
  request,
  link,
  disabled,
  atomic,
  shouldFocus = false,
  onAnswer
}: {
  request: SessionLinkEvent
  link: SessionLink
  disabled: boolean
  atomic: boolean
  shouldFocus?: boolean
  onAnswer: (body: string) => Promise<boolean>
}): React.JSX.Element {
  const t = useTranslate()

  const [collapsed, setCollapsed] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const asker = link.participants.find((participant) => participant.sessionId === request.actor)
  const heading = asker
    ? t('components.sessionLink.agentAsksYou', '{{agent}} asks you', {
        agent: tuiAgentDisplayName(asker.agent) ?? asker.agent
      })
    : t('components.sessionLink.ownerQuestion', 'Question for you')
  const prompt: AskPrompt = {
    questions: [
      {
        header: heading,
        question: request.body,
        multiSelect: false,
        options: request.choices ?? []
      }
    ]
  }
  const strip: AskPrompt = { questions: [{ ...prompt.questions[0]!, question: heading }] }
  return (
    <SecuritySurface>
      <div>
        {collapsed ? (
          <NativeChatPromptStrip
            card={{ kind: 'question', prompt: strip }}
            onExpand={() => setCollapsed(false)}
          />
        ) : null}
        <div hidden={collapsed}>
          <NativeChatQuestionCard
            prompt={prompt}
            heading={heading}
            context={
              <>
                <p>
                  {link.participants
                    .map(
                      (participant) =>
                        `${tuiAgentDisplayName(participant.agent) ?? participant.agent} (${participant.role === 'reviewer' ? t('components.sessionLink.reviewerRole', 'reviewer') : t('components.sessionLink.implementerRole', 'implementer')})`
                    )
                    .join(' ↔ ')}
                </p>
                <details>
                  <summary className="cursor-pointer">
                    {t('components.sessionLink.goal', 'Goal')}
                  </summary>
                  <p className="mt-2 whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
                    {link.story}
                  </p>
                </details>
                {!atomic ? (
                  <p>
                    {t(
                      'components.sessionLink.legacyAnswer',
                      'This host needs two steps: send your answer, then continue the link. Update the desktop app for one-step continuation.'
                    )}
                  </p>
                ) : null}
              </>
            }
            freeTextInputs={[
              {
                placeholder: t(
                  'components.sessionLink.groupOwnerAnswer',
                  'Your decision for all participants'
                )
              }
            ]}
            allowOther={request.allowOther ?? true}
            disabled={disabled}
            isSubmitting={submitting}
            requireAnswer
            submitLabel={
              atomic
                ? t('components.sessionLink.answerResume', 'Answer and continue')
                : t('components.sessionLink.sendAll', 'Send to all')
            }
            shouldFocus={!collapsed && shouldFocus}
            onAnswer={(selections) => {
              const body = formatAskAnswer(prompt, selections).trim()
              if (!body || disabled || submitting) {
                return
              }
              setSubmitting(true)
              void onAnswer(body).finally(() => setSubmitting(false))
            }}
            onCollapse={() => setCollapsed(true)}
          />
        </div>
      </div>
    </SecuritySurface>
  )
}
