import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import type { AiVaultSession } from '../../src/shared/ai-vault-types'
import type { AiVaultDeleteSessionResult } from '../../src/shared/ai-vault-session-deletion'

// Exercises the real on-disk delete against an isolated, disposable HOME (the
// E2E harness redirects os.homedir() there). The unit tests mock lstat/realpath/
// trashItem; this proves the whole IPC path actually removes files — and, for a
// directory-shaped agent, that the companion tree goes while the rewind buffer
// stays. Runs on Linux CI.

function jsonl(records: unknown[]): string {
  return `${records.map((record) => JSON.stringify(record)).join('\n')}\n`
}

function isolatedHome(electronApp: ElectronApplication): Promise<string> {
  return electronApp.evaluate(({ app }) => app.getPath('home'))
}

async function findSession(
  page: Page,
  agent: string,
  title: string
): Promise<AiVaultSession | undefined> {
  const sessions = (await page.evaluate(async () => {
    const result = await window.api.aiVault.listSessions({
      executionHostScope: 'local',
      force: true
    })
    return result.sessions
  })) as AiVaultSession[]
  return sessions.find((session) => session.agent === agent && session.title === title)
}

function deleteSession(page: Page, session: AiVaultSession): Promise<AiVaultDeleteSessionResult> {
  return page.evaluate(
    async (target) =>
      window.api.aiVault.deleteSession({
        agent: target.agent,
        filePath: target.filePath,
        executionHostId: target.executionHostId
      }),
    session
  )
}

test.describe('AI Vault session delete', () => {
  test('trashes a single-file session and removes it from the list', async ({
    electronApp,
    orcaPage
  }) => {
    const homeDir = await isolatedHome(electronApp)
    const title = `E2E gemini ${Date.now()}`
    const dir = path.join(homeDir, '.gemini', 'tmp', 'proj', 'chats')
    mkdirSync(dir, { recursive: true })
    const filePath = path.join(dir, 'session-e2e.json')
    writeFileSync(
      filePath,
      JSON.stringify({
        sessionId: 'gemini-e2e',
        startTime: '2026-07-20T10:00:00.000Z',
        lastUpdated: '2026-07-20T10:05:00.000Z',
        messages: [{ type: 'user', content: title, timestamp: '2026-07-20T10:00:00.000Z' }]
      })
    )

    const session = await findSession(orcaPage, 'gemini', title)
    expect(session, 'seeded gemini session should be listed').toBeTruthy()

    const result = await deleteSession(orcaPage, session as AiVaultSession)

    expect(result.outcome).toBe('deleted')
    expect(existsSync(filePath), 'transcript should be gone from disk').toBe(false)
    expect(await findSession(orcaPage, 'gemini', title)).toBeFalsy()
  })

  test('trashes a claude directory session and its companions but keeps file-history', async ({
    electronApp,
    orcaPage
  }) => {
    const homeDir = await isolatedHome(electronApp)
    const title = `E2E claude ${Date.now()}`
    const uuid = '11111111-2222-3333-4444-555555555555'
    const projectDir = path.join(homeDir, '.claude', 'projects', '-e2e-project')
    mkdirSync(projectDir, { recursive: true })
    const transcript = path.join(projectDir, `${uuid}.jsonl`)
    writeFileSync(
      transcript,
      jsonl([
        {
          type: 'user',
          sessionId: uuid,
          timestamp: '2026-07-20T10:00:00.000Z',
          cwd: projectDir,
          message: { role: 'user', content: title }
        }
      ])
    )
    const subagentsDir = path.join(projectDir, uuid, 'subagents')
    mkdirSync(subagentsDir, { recursive: true })
    writeFileSync(path.join(subagentsDir, 'agent-a1.jsonl'), jsonl([{ type: 'user' }]))
    const sessionEnvDir = path.join(homeDir, '.claude', 'session-env', uuid)
    mkdirSync(sessionEnvDir, { recursive: true })
    writeFileSync(path.join(sessionEnvDir, 'hook.sh'), 'export X=1\n')
    const fileHistoryDir = path.join(homeDir, '.claude', 'file-history', uuid)
    mkdirSync(fileHistoryDir, { recursive: true })
    const rewindFile = path.join(fileHistoryDir, 'deadbeef@v1')
    writeFileSync(rewindFile, 'earlier version of a user file\n')

    const session = await findSession(orcaPage, 'claude', title)
    expect(session, 'seeded claude session should be listed').toBeTruthy()

    const result = await deleteSession(orcaPage, session as AiVaultSession)

    expect(result.outcome).toBe('deleted')
    expect(existsSync(transcript), 'transcript gone').toBe(false)
    expect(
      existsSync(path.join(projectDir, uuid)),
      'session directory gone (no empty shell left behind)'
    ).toBe(false)
    expect(existsSync(sessionEnvDir), 'session-env companion gone').toBe(false)
    expect(existsSync(rewindFile), 'file-history rewind buffer preserved').toBe(true)
    expect(await findSession(orcaPage, 'claude', title)).toBeFalsy()
  })
})
