// Headless Session History must include the chat but exclude its one-shot naming request (#29973).
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from './helpers/orca-app'
import { launchHeadlessPairedRuntimeHost } from './helpers/headless-paired-runtime-host'
import { pairMobileClient } from './helpers/paired-mobile-client'
import { buildConversationNamePrompt } from '../../src/shared/conversation-name-generation'

function transcript(sessionId: string, cwd: string, turns: [string, string][]): string {
  return turns
    .map(([role, content], index) =>
      JSON.stringify({
        type: role,
        sessionId,
        timestamp: new Date(Date.UTC(2026, 9, 17, 3, 13, 49 + index)).toISOString(),
        cwd,
        entrypoint: 'sdk-cli',
        message: { role, content }
      })
    )
    .join('\n')
    .concat('\n')
}

test('Session History on a headless host hides chat-naming requests', async ({ testRepoPath }) => {
  test.setTimeout(240_000)
  const host = await launchHeadlessPairedRuntimeHost({ pairingScope: 'mobile' })
  const phone = pairMobileClient(host.offer)
  try {
    const claudeHome = host.env.CLAUDE_CONFIG_DIR ?? path.join(host.env.HOME ?? '', '.claude')
    const projectDir = path.join(claudeHome, 'projects', testRepoPath.replace(/[^\w]/g, '-'))
    mkdirSync(projectDir, { recursive: true })
    const chatId = randomUUID()
    const nameRequestId = randomUUID()
    writeFileSync(
      path.join(projectDir, `${chatId}.jsonl`),
      transcript(chatId, testRepoPath, [
        ['user', 'Refactor the codebase'],
        ['assistant', 'Starting on the refactor.']
      ])
    )
    writeFileSync(
      path.join(projectDir, `${nameRequestId}.jsonl`),
      transcript(nameRequestId, testRepoPath, [
        ['user', buildConversationNamePrompt({ firstPrompt: 'Refactor the codebase' })],
        ['assistant', 'Refactor the codebase']
      ])
    )

    const history = await phone.call<{ sessions: { sessionId: string }[] }>(
      'aiVault.listSessions',
      { limit: 50, force: true }
    )

    const listedIds = history.sessions.map((row) => row.sessionId)
    expect(listedIds).toContain(chatId)
    expect(listedIds).not.toContain(nameRequestId)
  } finally {
    await host.dispose()
  }
})
