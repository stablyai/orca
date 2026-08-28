import { describe, expect, it } from 'vitest'
import type { NativeChatBlock, NativeChatMessage } from './native-chat-types'
import { deriveNativeChatTasks, withoutNativeChatTaskToolBlocks } from './native-chat-task-list'

function message(id: string, blocks: NativeChatBlock[]): NativeChatMessage {
  return { id, role: 'assistant', blocks, timestamp: 0, source: 'transcript' }
}

describe('deriveNativeChatTasks', () => {
  it('uses the latest legacy TodoWrite snapshot', () => {
    const tasks = deriveNativeChatTasks([
      message('todos', [
        {
          type: 'tool-call',
          name: 'TodoWrite',
          input: {
            todos: [
              { content: 'Inspect the decoder', status: 'completed' },
              {
                content: 'Render the task list',
                activeForm: 'Rendering the task list',
                status: 'in_progress'
              }
            ]
          }
        }
      ])
    ])

    expect(tasks).toMatchObject([
      { subject: 'Inspect the decoder', status: 'completed' },
      {
        subject: 'Render the task list',
        activeForm: 'Rendering the task list',
        status: 'in_progress'
      }
    ])
  })

  it('accumulates TaskCreate results and applies TaskUpdate patches by id', () => {
    const tasks = deriveNativeChatTasks([
      message('create', [
        {
          type: 'tool-call',
          name: 'TaskCreate',
          input: { subject: 'Add tests', activeForm: 'Adding tests' }
        }
      ]),
      message('create-result', [
        { type: 'tool-result', output: '{"task":{"id":"7","subject":"Add tests"}}' }
      ]),
      message('update', [
        {
          type: 'tool-call',
          name: 'TaskUpdate',
          input: { taskId: '7', status: 'in_progress' }
        },
        { type: 'tool-result', output: 'updated' }
      ])
    ])

    expect(tasks).toEqual([
      { id: '7', subject: 'Add tests', activeForm: 'Adding tests', status: 'in_progress' }
    ])
  })

  it.each(['task_id', 'id'] as const)(
    'accepts repaired %s keys preserved in streamed TaskUpdate input',
    (taskIdKey) => {
      const tasks = deriveNativeChatTasks([
        message('create', [
          { type: 'tool-call', name: 'TaskCreate', input: { subject: 'Add tests' } },
          { type: 'tool-result', output: '{"task":{"id":"7","subject":"Add tests"}}' }
        ]),
        message('update', [
          {
            type: 'tool-call',
            name: 'TaskUpdate',
            input: { [taskIdKey]: '7', status: 'completed' }
          },
          { type: 'tool-result', output: 'updated' }
        ])
      ])

      expect(tasks).toEqual([{ id: '7', subject: 'Add tests', status: 'completed' }])
    }
  )

  it('replaces partial accumulated state with a TaskList snapshot', () => {
    const tasks = deriveNativeChatTasks([
      message('create', [
        { type: 'tool-call', name: 'TaskCreate', input: { subject: 'Partial' } },
        { type: 'tool-result', output: 'Task #1 created successfully' }
      ]),
      message('list', [
        { type: 'tool-call', name: 'TaskList', input: {} },
        {
          type: 'tool-result',
          output: JSON.stringify({
            tasks: [
              { id: '2', subject: 'Current work', status: 'in_progress' },
              { id: '3', subject: 'Next work', status: 'pending' }
            ]
          })
        }
      ])
    ])

    expect(tasks).toEqual([
      { id: '2', subject: 'Current work', status: 'in_progress' },
      { id: '3', subject: 'Next work', status: 'pending' }
    ])
  })

  it('ignores failed task mutations', () => {
    const tasks = deriveNativeChatTasks([
      message('failed', [
        { type: 'tool-call', name: 'TaskCreate', input: { subject: 'Never created' } },
        { type: 'tool-result', output: 'validation failed', isError: true }
      ])
    ])

    expect(tasks).toEqual([])
  })

  it('clears accumulated state when TaskList reports no tasks', () => {
    const tasks = deriveNativeChatTasks([
      message('create', [
        { type: 'tool-call', name: 'TaskCreate', input: { subject: 'Temporary' } },
        { type: 'tool-result', output: 'Task #1 created successfully' }
      ]),
      message('list', [
        { type: 'tool-call', name: 'TaskList', input: {} },
        { type: 'tool-result', output: 'No tasks found.' }
      ])
    ])

    expect(tasks).toEqual([])
  })
})

describe('withoutNativeChatTaskToolBlocks', () => {
  it('removes task calls and their FIFO results while preserving other tools', () => {
    const blocks: NativeChatBlock[] = [
      { type: 'text', text: 'Working' },
      { type: 'tool-call', name: 'TaskUpdate', input: { taskId: '1' } },
      { type: 'tool-call', name: 'Bash', input: { command: 'pnpm test' } },
      { type: 'tool-result', output: 'task updated' },
      { type: 'tool-result', output: 'tests passed' }
    ]

    expect(withoutNativeChatTaskToolBlocks(blocks)).toEqual([
      { type: 'text', text: 'Working' },
      { type: 'tool-call', name: 'Bash', input: { command: 'pnpm test' } },
      { type: 'tool-result', output: 'tests passed' }
    ])
  })
})
