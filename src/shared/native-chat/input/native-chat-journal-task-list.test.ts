import { describe, expect, it } from 'vitest'
import type {
  AgentJournalRenderItem,
  AgentJournalSnapshot
} from '../../agent-session-journal-types'
import { historyPageTaskList, nativeChatTaskSeedFromJournal } from './native-chat-journal-task-list'

const SUBJECT = 'Refuse to serve /api/* without explicit no-auth (U22)'

function item(
  itemId: string,
  sequence: number,
  body: AgentJournalRenderItem['body'],
  agentId?: string
): AgentJournalRenderItem {
  return {
    itemId,
    sequence,
    revision: 1,
    observedAt: sequence,
    body,
    ...(agentId ? { agentId } : {})
  }
}

function output(head: string): {
  head: string
  digest: string
  byteLength: number
  truncated: false
} {
  return { head, digest: 'd', byteLength: head.length, truncated: false }
}

describe('nativeChatTaskSeedFromJournal', () => {
  it('reads a prose TaskCreate that is not on the loaded page, and ignores a child task', () => {
    const items = [
      item('noise', 1, {
        kind: 'message',
        role: 'assistant',
        blocks: [{ type: 'text', text: 'hello' }]
      }),
      item('create', 2, {
        kind: 'tool-call',
        name: 'TaskCreate',
        input: { subject: SUBJECT, activeForm: 'Refusing unauthenticated /api' },
        state: 'completed',
        output: output(`Task #1 created successfully: ${SUBJECT}`)
      }),
      item(
        'child',
        3,
        {
          kind: 'tool-call',
          name: 'TaskCreate',
          input: { subject: 'Hidden' },
          state: 'completed',
          output: output('Task #9 created successfully: Hidden')
        },
        'child-1'
      ),
      item('plan', 4, {
        kind: 'status',
        text: '# Plan\n- step\n- another',
        presentation: 'plan-document'
      })
    ]
    // The plan document is the later writer, so it replaces the task book.
    expect(nativeChatTaskSeedFromJournal(items)?.tasks).toEqual([
      { content: 'step', status: 'pending' },
      { content: 'another', status: 'pending' }
    ])
    const tasksOnly = items.filter((row) => row.itemId !== 'plan')
    expect(nativeChatTaskSeedFromJournal(tasksOnly)?.tasks).toEqual([
      {
        id: '1',
        content: SUBJECT,
        status: 'pending',
        activeForm: 'Refusing unauthenticated /api'
      }
    ])
  })

  it('attaches that list to a history page and omits it when there are no tasks', () => {
    const withTasks: AgentJournalSnapshot = {
      sessionId: 's',
      cursor: { epoch: 'e', sequence: 2 },
      submissions: [],
      items: [
        item('create', 2, {
          kind: 'tool-call',
          name: 'TaskUpdate',
          input: { taskId: '1', status: 'completed', subject: SUBJECT },
          state: 'completed',
          output: output('Updated task #1 status')
        })
      ]
    }
    expect(historyPageTaskList(withTasks)).toEqual({
      taskList: { tasks: [{ id: '1', content: SUBJECT, status: 'completed' }] }
    })
    expect(
      historyPageTaskList({ ...withTasks, items: [], cursor: { epoch: 'e', sequence: 0 } })
    ).toEqual({})
  })
})
