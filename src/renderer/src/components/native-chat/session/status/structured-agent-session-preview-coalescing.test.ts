import { afterEach, expect, it, vi } from 'vitest'
import type { AgentSessionStatusSummary } from '../../../../../../shared/agent-session/agent-session-wire'
import { createHiddenPreviewCoalescer } from './structured-agent-session-preview-coalescing'
import type { Member } from './structured-agent-session-status-membership'

function summary(fields: Partial<AgentSessionStatusSummary>): AgentSessionStatusSummary {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the coalescer compares fields only.
  return {
    sessionId: 's',
    workspaceId: 'w',
    status: 'working',
    latestPrompt: 'p',
    ...fields
  } as AgentSessionStatusSummary
}

function member(tabId: string, captured: AgentSessionStatusSummary): Member {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the coalescer reads the tab id and captured summary only.
  return { tab: { id: tabId }, captured: { summary: captured } } as unknown as Member
}

afterEach(() => {
  vi.useRealTimers()
})

it('holds a hidden chat’s streaming frames to one projection per interval', () => {
  vi.useFakeTimers()
  const flushed: string[][] = []
  const previews = createHiddenPreviewCoalescer((due) => flushed.push([...due]), 250)
  const hidden = [member('tab-hidden', summary({ lastAssistantMessage: 'a', children: [] }))]
  for (const text of ['ab', 'abc', 'abcd']) {
    expect(
      previews.defer(
        's',
        hidden,
        summary({
          lastAssistantMessage: text,
          toolInput: text,
          updatedAt: text.length,
          children: []
        }),
        null
      )
    ).toBe(true)
  }
  expect(flushed).toEqual([])
  vi.advanceTimersByTime(250)
  expect(flushed).toEqual([['s']])
})

it('projects the front chat and every status transition at once', () => {
  const previews = createHiddenPreviewCoalescer(() => {})
  const captured = summary({ lastAssistantMessage: 'a' })
  const next = summary({ lastAssistantMessage: 'ab' })
  expect(previews.defer('s', [member('tab-front', captured)], next, 'tab-front')).toBe(false)
  expect(
    previews.defer('s', [member('tab-hidden', captured)], summary({ status: 'idle' }), null)
  ).toBe(false)
  expect(
    previews.defer('s', [member('tab-hidden', captured)], { ...next, stopping: true }, null)
  ).toBe(false)
  previews.dispose()
})
