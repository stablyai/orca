import { rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from './helpers/orca-app'
import { launchHeadlessPairedRuntimeHost } from './helpers/headless-paired-runtime-host'

function claudeLine(id: string, text: string): string {
  return `${JSON.stringify({
    type: 'assistant',
    uuid: id,
    message: { role: 'assistant', content: [{ type: 'text', text }] }
  })}\n`
}

test('routes native-chat ownership through a headless runtime', async () => {
  test.setTimeout(180_000)
  const host = await launchHeadlessPairedRuntimeHost()
  let transcriptPath: string | undefined

  try {
    const homePath = await host.app.evaluate(({ app }) => app.getPath('home'))
    transcriptPath = path.join(homePath, `native-chat-headless-${Date.now()}.jsonl`)
    writeFileSync(transcriptPath, claudeLine('headless-real', 'headless runtime bytes'))
    const owned = await host.client.call<{
      messages: { id: string }[]
      hasMore: boolean
    }>('nativeChat.readSession', {
      agent: 'claude',
      sessionId: 'headless-session',
      transcriptPath,
      limit: 40
    })
    expect(owned.result).toMatchObject({
      messages: [{ id: 'headless-real' }],
      hasMore: false
    })

    // A pane-scoped request with unknown ownership must not inherit the server's filesystem.
    const unowned = await host.client.call<{ error: string }>('nativeChat.readSession', {
      agent: 'claude',
      sessionId: 'headless-session',
      transcriptPath,
      paneKey: 'missing-pane:11111111-1111-4111-8111-111111111111',
      limit: 40
    })
    expect(unowned.result).toEqual({ error: 'Transcript unverifiable on the remote host' })
  } finally {
    if (transcriptPath) {
      rmSync(transcriptPath, { force: true })
    }
    await host.dispose()
  }
})
