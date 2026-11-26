import { afterEach, expect, it, vi } from 'vitest'
import { sendPipelineSessionDiscussion } from './pipeline-session-discussion-send'

afterEach(() => vi.unstubAllGlobals())
it('reuses the exact request after uncertain delivery and permits a new one after a known rejection', async () => {
  const bridge = vi
    .fn()
    .mockResolvedValueOnce({
      handled: true,
      accepted: false,
      receipt: { state: 'outcome_unknown' }
    })
    .mockResolvedValueOnce({ handled: true, accepted: true, receipt: { state: 'ready' } })
    .mockResolvedValueOnce({
      handled: true,
      accepted: false,
      rejected: 'pipeline_budget_exhausted'
    })
    .mockResolvedValueOnce({ handled: true, accepted: true, receipt: { state: 'ready' } })
  vi.stubGlobal('window', { api: { pipelineOwner: { discussBoundSession: bridge } } })
  const input = {
    requestId: 'discussion-ui-1',
    sessionId: 'session-retry-test',
    message: 'Уточни порядок округления скидки.',
    hasAttachments: false
  }
  expect((await sendPipelineSessionDiscussion(input)).accepted).toBe(false)
  await sendPipelineSessionDiscussion({ ...input, requestId: 'discussion-ui-2' })
  expect(bridge.mock.calls[1][0]).toMatchObject({
    requestId: 'discussion-ui-1',
    message: 'Уточни порядок округления скидки.'
  })
  await sendPipelineSessionDiscussion({ ...input, requestId: 'discussion-ui-3' })
  await sendPipelineSessionDiscussion({ ...input, requestId: 'discussion-ui-4' })
  expect(bridge.mock.calls[3][0]).toMatchObject({ requestId: 'discussion-ui-4' })
})
