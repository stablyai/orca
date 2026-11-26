import { describe, expect, it } from 'vitest'
import type { LinkedWorkItemSummary } from '@/lib/workspace/creation/new-workspace'
import { buildQuickPipelineTask } from './submission/quick-creation-request'

describe('pipeline task snapshot', () => {
  it('rejects oversized requirements instead of silently truncating them', () => {
    expect(() =>
      buildQuickPipelineTask({
        workspaceName: 'task',
        note: 'Я'.repeat(12001),
        prompt: '',
        linkedWorkItem: null
      })
    ).toThrow()
  })
  it('preserves the task description without synthetic missing-item text', () => {
    expect(
      buildQuickPipelineTask({
        workspaceName: 'cart-discount-02',
        note: 'Проверить скидку и округление.',
        prompt: '',
        linkedWorkItem: null
      })
    ).toBe('cart-discount-02\nПроверить скидку и округление.')
  })

  it('uses only the name when no description or linked item was supplied', () => {
    expect(
      buildQuickPipelineTask({
        workspaceName: 'cart-discount-02',
        note: '',
        prompt: '',
        linkedWorkItem: null
      })
    ).toBe('cart-discount-02')
  })

  it('retains linked issue details alongside the owner description', () => {
    const linkedWorkItem: LinkedWorkItemSummary = {
      provider: 'jira',
      type: 'issue',
      number: 39,
      title: 'Native pipeline pilot',
      url: 'https://jira.example.test/browse/ORCA-39',
      jiraIdentifier: 'ORCA-39'
    }
    const task = buildQuickPipelineTask({
      workspaceName: 'orca-39',
      note: 'Preserve the acceptance criteria.',
      prompt: '',
      linkedWorkItem
    })
    expect(task).toBe(
      `orca-39\nPreserve the acceptance criteria.\n${JSON.stringify(linkedWorkItem)}`
    )
  })

  it('keeps a resolved provider prompt as the task when one is available', () => {
    expect(
      buildQuickPipelineTask({
        workspaceName: 'orca-39',
        note: 'Fallback note',
        prompt: 'Resolved provider task with acceptance criteria',
        linkedWorkItem: null
      })
    ).toBe('Resolved provider task with acceptance criteria')
  })
})
