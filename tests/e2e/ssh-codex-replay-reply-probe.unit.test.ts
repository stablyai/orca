import type { ElectronApplication } from '@stablyai/playwright-test'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { installSshReplayReplyProbe, readSshReplayReplies } from './ssh-codex-replay-reply-probe'

beforeEach(() => vi.stubGlobal('__orcaSshCodexReplayReplies', undefined))
afterEach(() => vi.unstubAllGlobals())

function harness(result: unknown) {
  const original = vi.fn().mockResolvedValue(result)
  const handlers = new Map([['pty:spawn', original]])
  const app = {
    evaluate: (fn: (electron: unknown, arg: unknown) => unknown, arg: unknown) =>
      fn({ ipcMain: { _invokeHandlers: handlers } }, arg)
  } as unknown as ElectronApplication
  return { app, original, handlers }
}

it('records the original PTY reattach reply without changing the handler result', async () => {
  const result = { id: 'ssh:target@@pty-1', isReattach: true, replay: 'restored output' }
  const { app, handlers, original } = harness(result)
  await installSshReplayReplyProbe(app, result.id)
  const event = {}
  const args = { sessionId: result.id }
  expect(await handlers.get('pty:spawn')!(event, args)).toBe(result)
  expect(original).toHaveBeenCalledWith(event, args)
  expect(await readSshReplayReplies(app)).toEqual([
    { id: result.id, length: 15, preview: 'restored output', source: 'spawn-reply' }
  ])
})

it.each([
  [{}, { id: 'wanted', isReattach: true, replay: 'initial' }],
  [{ sessionId: 'other' }, { id: 'other', isReattach: true, replay: 'other PTY' }],
  [{ sessionId: 'wanted' }, { id: 'replacement', isReattach: true, replay: 'new PTY' }],
  [{ sessionId: 'wanted' }, { id: 'wanted', replay: 'no reattach proof' }],
  [{ sessionId: 'wanted' }, { id: 'wanted', isReattach: true, replay: '' }],
  [{ sessionId: 'wanted' }, { id: 'wanted', isReattach: true, snapshot: 'not replay' }]
])('does not count unrelated or unproven replay: %j', async (args, result) => {
  const { app, handlers } = harness(result)
  await installSshReplayReplyProbe(app, 'wanted')
  expect(await handlers.get('pty:spawn')!({}, args)).toBe(result)
  expect(await readSshReplayReplies(app)).toEqual([])
})

it('preserves a failed reattach without recording replay', async () => {
  const { app, handlers, original } = harness(null)
  const error = new Error('unverifiable')
  original.mockRejectedValue(error)
  await installSshReplayReplyProbe(app, 'wanted')
  await expect(handlers.get('pty:spawn')!({}, { sessionId: 'wanted' })).rejects.toBe(error)
  expect(await readSshReplayReplies(app)).toEqual([])
})
