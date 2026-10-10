import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'

export const claudeGroupedQuestionPromptItems: AgentJournalRenderItem[] = [
  {
    itemId: 'question-item',
    revision: 1,
    sequence: 1,
    observedAt: 1,
    body: {
      kind: 'question',
      question: '2 grouped questions from Claude',
      options: [],
      questions: [
        {
          id: 'q1',
          header: 'Targets',
          question: 'Which targets?',
          multiSelect: true,
          options: [
            { id: 'target-web', label: 'Web' },
            { id: 'target-mobile', label: 'Mobile' }
          ],
          freeTextQuestionId: 'q1'
        },
        {
          id: 'q2',
          header: 'Host',
          question: 'Where should it run?',
          multiSelect: false,
          options: [],
          freeTextQuestionId: 'q2'
        }
      ],
      resolution: {
        state: 'pending',
        selectedOptionId: null,
        resolvedBy: null,
        resolvedAt: null
      }
    }
  }
]

export const legacySingleQuestionPromptItems: AgentJournalRenderItem[] = [
  {
    itemId: 'legacy-question-item',
    revision: 1,
    sequence: 1,
    observedAt: 1,
    body: {
      kind: 'question',
      question: 'Pick a library',
      options: [
        { id: 'q1:choice-1', label: 'React' },
        { id: 'q1:choice-2', label: 'Vue' }
      ],
      freeTextQuestionId: 'q1',
      resolution: {
        state: 'pending',
        selectedOptionId: null,
        resolvedBy: null,
        resolvedAt: null
      }
    }
  }
]
