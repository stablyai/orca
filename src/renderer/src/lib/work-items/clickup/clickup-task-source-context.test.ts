import { describe, expect, it } from 'vitest'
import type { TaskSourceContext } from '../../../../../shared/work-items/task-source-context'
import { bindClickUpTaskSourceContext } from './clickup-task-source-context'

const detailContext: TaskSourceContext = {
  kind: 'task-source',
  provider: 'clickup',
  projectId: 'p1',
  hostId: 'local',
  providerIdentity: { provider: 'clickup', workspaceId: 'A', workspaceName: 'Alpha' },
  accountLabel: 'Alpha'
}

function bind(workspaceId: string) {
  return bindClickUpTaskSourceContext({
    task: { workspaceId },
    workspaces: [],
    sourceContext: detailContext
  })
}

describe('bindClickUpTaskSourceContext', () => {
  it('keeps the context labels for the same Workspace when the live list no longer has it', () => {
    const bound = bind('A')

    expect(bound?.providerIdentity).toEqual({
      provider: 'clickup',
      workspaceId: 'A',
      workspaceName: 'Alpha'
    })
    expect(bound?.accountLabel).toBe('Alpha')
  })

  it('does not borrow the labels of a different Workspace', () => {
    const bound = bind('B')

    expect(bound?.providerIdentity).toEqual({
      provider: 'clickup',
      workspaceId: 'B',
      workspaceName: null
    })
    expect(bound?.accountLabel ?? null).toBeNull()
  })
})
