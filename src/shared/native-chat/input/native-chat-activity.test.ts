import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../native-chat-types'
import {
  latestNativeChatTaskList,
  latestNativeChatTaskSeed,
  nativeChatSubagentActivities,
  nativeChatTaskListFromPlanDocument,
  nativeChatVisibleTaskList
} from './native-chat-activity'
import { foldToolMessages } from '../tools/native-chat-tool-fold'

function message(
  id: string,
  blocks: NativeChatMessage['blocks'],
  extra: Partial<NativeChatMessage> = {}
): NativeChatMessage {
  return { id, role: 'assistant', timestamp: 1, source: 'transcript', blocks, ...extra }
}

describe('latestNativeChatTaskList', () => {
  it('keeps the latest todo or plan snapshot and ignores a failed rewrite', () => {
    const list = latestNativeChatTaskList([
      message('todo', [
        {
          type: 'tool-call',
          name: 'TodoWrite',
          input: { todos: [{ content: 'Read', status: 'pending' }] }
        }
      ]),
      message('plan', [
        {
          type: 'tool-call',
          name: 'update_plan',
          input: { plan: [{ step: 'Read', status: 'completed' }], explanation: 'Done reading' }
        }
      ]),
      message('failed', [
        {
          type: 'tool-call',
          name: 'TodoWrite',
          state: 'failed',
          input: { todos: [] }
        }
      ])
    ])
    expect(list).toEqual({
      tasks: [{ content: 'Read', status: 'completed' }],
      explanation: 'Done reading'
    })
  })

  it('reads an ACP plan checklist, including a cancelled box', () => {
    expect(
      nativeChatTaskListFromPlanDocument(
        '# Plan\n\n- [x] Read\n- [~] Write\n- [-] Skip\n- [ ] Test'
      )
    ).toEqual({
      tasks: [
        { content: 'Read', status: 'completed' },
        { content: 'Write', status: 'in_progress' },
        { content: 'Skip', status: 'cancelled' },
        { content: 'Test', status: 'pending' }
      ]
    })
    expect(nativeChatTaskListFromPlanDocument('# Just a plan')).toBeNull()
    expect(nativeChatTaskListFromPlanDocument('# Plan\n- step\n- another')).toEqual({
      tasks: [
        { content: 'step', status: 'pending' },
        { content: 'another', status: 'pending' }
      ]
    })
    expect(nativeChatTaskListFromPlanDocument('- [x] Read\n- also')?.tasks).toEqual([
      { content: 'Read', status: 'completed' }
    ])
    const list = latestNativeChatTaskList([
      message('plan', [
        {
          type: 'text',
          presentation: 'plan-document',
          text: '- [x] Read\n- [ ] Write'
        }
      ])
    ])
    expect(list?.tasks.map((task) => task.status)).toEqual(['completed', 'pending'])
  })

  it('folds Claude task tools and lets a later TaskList replace them', () => {
    const list = latestNativeChatTaskList([
      message('create', [
        {
          type: 'tool-call',
          name: 'TaskCreate',
          input: { subject: 'Read the code', activeForm: 'Reading the code' }
        },
        {
          type: 'tool-result',
          output: JSON.stringify({ task: { id: '1', subject: 'Read the code' } })
        }
      ]),
      message('start', [
        {
          type: 'tool-call',
          name: 'TaskUpdate',
          input: { taskId: '1', status: 'in_progress', activeForm: 'Reading the code' }
        },
        { type: 'tool-result', output: JSON.stringify({ success: true, taskId: '1' }) }
      ]),
      message('drop', [
        { type: 'tool-call', name: 'TaskUpdate', input: { taskId: '2', status: 'deleted' } },
        { type: 'tool-result', output: JSON.stringify({ success: true, taskId: '2' }) }
      ]),
      message('cancel', [
        {
          type: 'tool-call',
          name: 'TaskCreate',
          input: { subject: 'Skip the notes' }
        },
        {
          type: 'tool-result',
          output: JSON.stringify({ task: { id: '3', subject: 'Skip the notes' } })
        }
      ]),
      message('cancel-update', [
        { type: 'tool-call', name: 'TaskUpdate', input: { taskId: '3', status: 'cancelled' } },
        { type: 'tool-result', output: JSON.stringify({ success: true, taskId: '3' }) }
      ]),
      message('reject', [
        { type: 'tool-call', name: 'TaskUpdate', input: { taskId: '1', status: 'completed' } },
        { type: 'tool-result', output: 'no', isError: true }
      ])
    ])
    expect(list?.tasks).toEqual([
      { content: 'Read the code', status: 'in_progress', activeForm: 'Reading the code' },
      { content: 'Skip the notes', status: 'cancelled' }
    ])

    const replaced = latestNativeChatTaskList([
      message('create', [
        { type: 'tool-call', name: 'TaskCreate', input: { subject: 'Old' } },
        { type: 'tool-result', output: JSON.stringify({ task: { id: '1', subject: 'Old' } }) }
      ]),
      message('list', [
        { type: 'tool-call', name: 'TaskList', input: {} },
        {
          type: 'tool-result',
          output: JSON.stringify({
            tasks: [{ id: '9', subject: 'Fresh', status: 'pending' }]
          })
        }
      ])
    ])
    expect(replaced?.tasks).toEqual([{ content: 'Fresh', status: 'pending' }])
  })

  it('reads the prose TaskCreate result current Claude Code writes', () => {
    const subject = 'Refuse to serve /api/* without explicit no-auth (U22)'
    const folded = foldToolMessages([
      message('create', [
        {
          type: 'tool-call',
          name: 'TaskCreate',
          input: { subject, activeForm: 'Refusing unauthenticated /api' }
        }
      ]),
      message(
        'create-result',
        [{ type: 'tool-result', output: `Task #1 created successfully: ${subject}` }],
        {
          role: 'user'
        }
      ),
      message('done', [
        { type: 'tool-call', name: 'TaskUpdate', input: { taskId: '1', status: 'completed' } }
      ]),
      message('done-result', [{ type: 'tool-result', output: 'Updated task #1 status' }], {
        role: 'user'
      })
    ])
    expect(latestNativeChatTaskList(folded)?.tasks).toEqual([
      {
        content: subject,
        status: 'completed',
        activeForm: 'Refusing unauthenticated /api'
      }
    ])
    expect(latestNativeChatTaskSeed(folded)?.tasks[0]).toMatchObject({ id: '1', content: subject })
  })

  it('keeps a seeded list when this window has no task tools, then applies one update', () => {
    const subject = 'Refuse to serve /api/* without explicit no-auth (U22)'
    const seed = { tasks: [{ id: '1', content: subject, status: 'pending' as const }] }
    expect(latestNativeChatTaskList([], seed)?.tasks).toEqual([
      { content: subject, status: 'pending' }
    ])
    expect(
      latestNativeChatTaskList(
        [
          message('done', [
            { type: 'tool-call', name: 'TaskUpdate', input: { taskId: '1', status: 'completed' } },
            { type: 'tool-result', output: 'Updated task #1 status' }
          ])
        ],
        seed
      )?.tasks
    ).toEqual([{ content: subject, status: 'completed' }])
  })

  it('clears on an explicit empty list and stays absent until one exists', () => {
    expect(latestNativeChatTaskList([])).toBeNull()
    expect(
      latestNativeChatTaskList([
        message('empty', [{ type: 'tool-call', name: 'TodoWrite', input: { todos: [] } }])
      ])?.tasks
    ).toEqual([])
  })
})

describe('nativeChatVisibleTaskList', () => {
  const session = [
    message('todo', [
      {
        type: 'tool-call',
        name: 'TodoWrite',
        input: { todos: [{ content: 'Read', status: 'pending' }] }
      }
    ])
  ]
  const child = [
    message('child', [
      {
        type: 'tool-call',
        name: 'TodoWrite',
        input: { todos: [{ content: 'Search', status: 'in_progress' }] }
      }
    ])
  ]

  it('keeps the main plan while the open subagent has no list', () => {
    expect(nativeChatVisibleTaskList(session, null)?.tasks.map((task) => task.content)).toEqual([
      'Read'
    ])
    expect(nativeChatVisibleTaskList(session, [])?.tasks.map((task) => task.content)).toEqual([
      'Read'
    ])
  })

  it('shows the open subagent’s own list', () => {
    expect(nativeChatVisibleTaskList(session, child)?.tasks.map((task) => task.content)).toEqual([
      'Search'
    ])
  })
})

describe('nativeChatSubagentActivities', () => {
  it('lists roster state and the child transcript’s latest line', () => {
    const conversation = [
      message('roster', [
        {
          type: 'subagent-group',
          groupId: 'turn-1',
          agents: [
            { id: 'child-1', label: 'Explore', state: 'working' },
            { id: 'child-2', label: 'Review', state: 'completed' }
          ]
        }
      ])
    ]
    const child = message(
      'line',
      [
        { type: 'text', text: 'Kicked off subagent Explore' },
        { type: 'tool-call', name: 'Read', input: {} },
        { type: 'text', text: 'Found the composer pill.' }
      ],
      { agentId: 'child-1', producerKind: 'agent' }
    )
    const activities = nativeChatSubagentActivities(
      conversation,
      new Map([['child-1', [{ message: child }]]])
    )
    expect(activities).toEqual([
      {
        id: 'child-1',
        label: 'Explore',
        state: 'working',
        activity: 'Found the composer pill.'
      },
      { id: 'child-2', label: 'Review', state: 'completed', activity: null }
    ])
  })
})
