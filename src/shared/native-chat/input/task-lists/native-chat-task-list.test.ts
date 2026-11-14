import { describe, expect, it } from 'vitest'
import {
  diffNativeChatTaskLists,
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
