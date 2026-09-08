import { describe, expect, it } from 'vitest'
import { buildAgentPromptWithContext } from './new-workspace'
import {
  getLaunchableWorkItemDraftContent,
  getLinkedWorkItemPromptContext,
  resolveQuickCreateLinkedWorkItemPrompt
} from './linked-work-item-context'

const task = {
  provider: 'kaneo' as const,
  number: 42,
  title: 'Fix booking',
  url: 'https://tasks.example.com/dashboard/workspace/ws/project/proj/task/task',
  linkedContext: {
    provider: 'kaneo' as const,
    version: 1 as const,
    renderedText: 'Task description from a previously saved draft'
  }
}

describe('Kaneo agent context', () => {
  it('uses only the link, even when an older draft contains task prose', () => {
    expect(getLinkedWorkItemPromptContext(task)).toEqual({
      linkedUrls: [task.url],
      linkedContextBlocks: []
    })
    expect(getLaunchableWorkItemDraftContent(task)).toBe(task.url)
  })

  it.each(['', 'Implement and test'])(
    'preserves user instructions in quick and folder creation: %s',
    (note) => {
      expect(resolveQuickCreateLinkedWorkItemPrompt(task, note)).toEqual({
        prompt: '',
        draftPrompt: note ? `${note}\n\n${task.url}` : task.url
      })
    }
  )

  it('includes user instructions and attachments without the task title or description', () => {
    const context = getLinkedWorkItemPromptContext(task)
    expect(
      buildAgentPromptWithContext(
        'Implement and test',
        ['acceptance.txt'],
        context.linkedUrls,
        context.linkedContextBlocks
      )
    ).toBe(
      `Implement and test\n\nAttachments:\n- acceptance.txt\n\nLinked work items:\n- ${task.url}`
    )
  })
})
