import type { ElectronApplication } from '@stablyai/playwright-test'

type ReplayPayload = { id: string; length: number; preview: string; source: 'spawn-reply' }
type SpawnHandler = (event: unknown, args: Record<string, unknown>) => Promise<unknown>
type ReplayReplyScope = typeof globalThis & {
  __orcaSshCodexReplayReplies?: ReplayPayload[]
}

export async function installSshReplayReplyProbe(
  app: ElectronApplication,
  ptyId: string
): Promise<void> {
  await app.evaluate(({ ipcMain }, expectedPtyId) => {
    const scope = globalThis as ReplayReplyScope
    if (scope.__orcaSshCodexReplayReplies) {
      throw new Error('SSH replay reply probe already installed')
    }
    const handlers = (ipcMain as unknown as { _invokeHandlers?: Map<string, SpawnHandler> })
      ._invokeHandlers
    const original = handlers?.get('pty:spawn')
    if (!handlers || !original) {
      throw new Error('PTY spawn handler unavailable')
    }
    const payloads: ReplayPayload[] = []
    scope.__orcaSshCodexReplayReplies = payloads
    // SSH reconnect returns its replay with the reattach reply, without a pty:replay push.
    handlers.set('pty:spawn', async (event, args) => {
      const result = await original(event, args)
      if (
        args.sessionId === expectedPtyId &&
        result &&
        typeof result === 'object' &&
        'id' in result &&
        result.id === expectedPtyId &&
        'isReattach' in result &&
        result.isReattach === true &&
        'replay' in result &&
        typeof result.replay === 'string' &&
        result.replay.length > 0
      ) {
        payloads.push({
          id: expectedPtyId,
          length: result.replay.length,
          preview: result.replay.slice(-400),
          source: 'spawn-reply'
        })
      }
      return result
    })
  }, ptyId)
}

export async function readSshReplayReplies(app: ElectronApplication): Promise<ReplayPayload[]> {
  return app.evaluate(() => (globalThis as ReplayReplyScope).__orcaSshCodexReplayReplies ?? [])
}
