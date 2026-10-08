import { describe, expect, it } from 'vitest'
import {
  diffNativeChatTaskLists,
  nativeChatTaskLabel,
  normalizeNativeChatTaskList,
  type NativeChatTask,
  type NativeChatTaskList
} from './native-chat-task-list'

const task = (content: string, status: NativeChatTask['status'] = 'pending'): NativeChatTask => ({
  content,
  status
})
const list = (...tasks: NativeChatTask[]): NativeChatTaskList => ({ tasks })

describe('normalizeNativeChatTaskList', () => {
  it('normalizes Claude tasks and uses activeForm only while in progress', () => {
    const result = normalizeNativeChatTaskList('TodoWrite', {
      todos: [
        { content: 'Read', status: 'completed', activeForm: 'Reading' },
        { content: 'Write', status: 'in_progress', activeForm: 'Writing' },
        { content: 'Test', status: 'pending', activeForm: 'Testing' }
      ]
    })!
    expect(result.tasks.map(nativeChatTaskLabel)).toEqual(['Read', 'Writing', 'Test'])
    expect(result.tasks.map((entry) => entry.status)).toEqual([
      'completed',
      'in_progress',
      'pending'
    ])
  })

  it('normalizes Codex JSON-string arguments and explanation', () => {
    expect(
      normalizeNativeChatTaskList(
        'update_plan',
        JSON.stringify({
          explanation: 'Proceed with verification',
          plan: [{ step: 'Test', status: 'in_progress' }]
        })
      )
    ).toEqual({ explanation: 'Proceed with verification', tasks: [task('Test', 'in_progress')] })
  })

  it('defaults unknown/missing statuses and ignores invalid entries', () => {
    expect(
      normalizeNativeChatTaskList(' TodoWrite ', {
        todos: [
          null,
          [],
          4,
          {},
          { content: ' ' },
          { content: 7 },
          { content: ' One ', status: 'unknown', activeForm: 4 },
          { content: 'Two' }
        ]
      })
    ).toEqual(list(task('One'), task('Two')))
  })

  it.each([undefined, null, 42, [], '{', '{}', { todos: null }, { todos: [{}] }])(
    'returns null for malformed input %j',
    (input) => {
      expect(normalizeNativeChatTaskList('TodoWrite', input)).toBeNull()
    }
  )

  it('keeps empty lists valid and recognizes only exact tool families', () => {
    expect(normalizeNativeChatTaskList('update_plan', { plan: [] })).toEqual(list())
    expect(normalizeNativeChatTaskList('TodoWrite', { todos: [] })).toEqual(list())
    expect(normalizeNativeChatTaskList('mcp__server__TodoWrite', { todos: [] })).toBeNull()
    expect(normalizeNativeChatTaskList('ExitPlanMode', { plan: [] })).toBeNull()
    expect(normalizeNativeChatTaskList('update_plan', { todos: [] })).toBeNull()
  })
})

describe('diffNativeChatTaskLists', () => {
  it('reports completions and starts, omitting unchanged tasks', () => {
    expect(
      diffNativeChatTaskLists(
        list(task('Read', 'in_progress'), task('Write'), task('Test')),
        list(task('Read', 'completed'), task('Write', 'in_progress'), task('Test'))
      )
    ).toEqual([
      { kind: 'completed', task: task('Read', 'completed') },
      { kind: 'started', task: task('Write', 'in_progress') }
    ])
  })

  it('ignores reorder-only updates and explanation changes', () => {
    expect(
      diffNativeChatTaskLists(list(task('A'), task('B')), {
        tasks: [task('B'), task('A')],
        explanation: 'Reordered'
      })
    ).toEqual([])
  })

  it('matches duplicate contents by occurrence', () => {
    expect(
      diffNativeChatTaskLists(
        list(task('A'), task('A', 'in_progress')),
        list(task('A', 'completed'), task('A', 'in_progress'))
      )
    ).toEqual([{ kind: 'completed', task: task('A', 'completed') }])
  })

  it('reports renamed content as an addition and removal', () => {
    expect(diffNativeChatTaskLists(list(task('Old')), list(task('New')))).toEqual([
      { kind: 'added', task: task('New') },
      { kind: 'removed', task: task('Old') }
    ])
  })

  it('reports resets, reopening, and activeForm-only edits', () => {
    const changed = { ...task('C', 'in_progress'), activeForm: 'Checking C' }
    expect(
      diffNativeChatTaskLists(
        list(task('A', 'completed'), task('B', 'completed'), task('C', 'in_progress')),
        list(task('A'), task('B', 'in_progress'), changed)
      )
    ).toEqual([
      { kind: 'pending', task: task('A') },
      { kind: 'started', task: task('B', 'in_progress') },
      { kind: 'updated', task: changed }
    ])
  })

  it('reports clearing a list and removing a duplicate', () => {
    expect(diffNativeChatTaskLists(list(task('A')), list())).toEqual([
      { kind: 'removed', task: task('A') }
    ])
    expect(diffNativeChatTaskLists(list(task('A'), task('A')), list(task('A')))).toEqual([
      { kind: 'removed', task: task('A') }
    ])
  })
})
