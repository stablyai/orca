import { describe, expect, it } from 'vitest'
import { BACKLOG_TASKS_CAPABILITY } from './backlog-capability'
import * as protocol from './protocol-version'
import { WORKSPACE_ATTACHMENT_RUNTIME_CAPABILITIES } from './workspace-attachment-capabilities'
import {
  PROJECT_HOST_SETUP_RUNTIME_CAPABILITY,
  TASK_SOURCE_CONTEXT_RUNTIME_CAPABILITY,
  WORKSPACE_RUN_CONTEXT_RUNTIME_CAPABILITY,
  WORKTREE_LINKED_WORK_ITEM_CONTEXT_RUNTIME_CAPABILITY,
  WORKSPACE_CONTEXT_RUNTIME_CAPABILITIES
} from './workspace-context-capabilities'

describe('workspace context capabilities', () => {
  it('preserves the public protocol exports and literal values', () => {
    const exports = {
      PROJECT_HOST_SETUP_RUNTIME_CAPABILITY,
      TASK_SOURCE_CONTEXT_RUNTIME_CAPABILITY,
      WORKSPACE_RUN_CONTEXT_RUNTIME_CAPABILITY,
      WORKTREE_LINKED_WORK_ITEM_CONTEXT_RUNTIME_CAPABILITY
    }
    expect(exports).toEqual({
      PROJECT_HOST_SETUP_RUNTIME_CAPABILITY: 'project-host-setup.v1',
      TASK_SOURCE_CONTEXT_RUNTIME_CAPABILITY: 'task-source-context.v1',
      WORKSPACE_RUN_CONTEXT_RUNTIME_CAPABILITY: 'workspace-run-context.v1',
      WORKTREE_LINKED_WORK_ITEM_CONTEXT_RUNTIME_CAPABILITY: 'worktree.linked-work-item-context.v1'
    })
    expect(protocol).toMatchObject(exports)
  })

  it('keeps the advertised entries in order between mobile tasks and workspace attachments', () => {
    expect(WORKSPACE_CONTEXT_RUNTIME_CAPABILITIES).toEqual([
      PROJECT_HOST_SETUP_RUNTIME_CAPABILITY,
      TASK_SOURCE_CONTEXT_RUNTIME_CAPABILITY,
      BACKLOG_TASKS_CAPABILITY,
      WORKSPACE_RUN_CONTEXT_RUNTIME_CAPABILITY,
      WORKTREE_LINKED_WORK_ITEM_CONTEXT_RUNTIME_CAPABILITY
    ])
    const start = protocol.RUNTIME_CAPABILITIES.indexOf('mobile.tasks.v1')
    expect(start).toBeGreaterThanOrEqual(0)
    const expected = [
      'mobile.tasks.v1',
      ...WORKSPACE_CONTEXT_RUNTIME_CAPABILITIES,
      ...WORKSPACE_ATTACHMENT_RUNTIME_CAPABILITIES,
      protocol.WORKTREE_GITHUB_PR_SUPPRESSION_RUNTIME_CAPABILITY
    ]
    expect(protocol.RUNTIME_CAPABILITIES.slice(start, start + expected.length)).toEqual(expected)
    expect(new Set(protocol.RUNTIME_CAPABILITIES).size).toBe(protocol.RUNTIME_CAPABILITIES.length)
  })
})
