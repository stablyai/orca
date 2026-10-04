import { copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { createRestartSession, attachRepoAndOpenTerminal } from './helpers/orca-restart'
import { getE2ECompletedOnboardingProfile } from './helpers/e2e-completed-onboarding-profile'
import { structuredAgentSessionCreateParams } from '../../src/shared/structured-agent-session-create'
import { ACP_FIXTURE } from '../../src/main/cursor/cursor-acp-protocol-fixture'

async function assertHiddenIsolated(app: ElectronApplication): Promise<void> {
  const proof = await app.evaluate(({ app, BrowserWindow }) => ({
    home: app.getPath('home'),
    expectedHome: process.env.ORCA_E2E_HOME_DIR,
    trustDisabled: process.env.ORCA_DISABLE_CODEX_TRUST_RPC,
    background: process.env.ORCA_BACKGROUND_LAUNCH,
    hidden: BrowserWindow.getAllWindows().every(
      (window) => !window.isVisible() && !window.isFocused()
    ),
    cursorConfigOverride: process.env.CURSOR_CONFIG_DIR,
    xdgConfigOverride: process.env.XDG_CONFIG_HOME
  }))
  expect(proof.home).toBe(proof.expectedHome)
  expect(proof.trustDisabled).toBe('1')
  expect(proof.background).toBe('1')
  expect(proof.hidden).toBe(true)
  expect(proof.cursorConfigOverride).toBeUndefined()
  expect(proof.xdgConfigOverride).toBeUndefined()
}

async function cdpProof(page: Page, destination: string): Promise<void> {
  const cdp = await page.context().newCDPSession(page)
  try {
    const box = await page.locator('[data-native-chat-root="true"]').boundingBox()
    if (!box) {
      throw new Error('Native Chat renderer has no visible bounds')
    }
    const screenshot = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      clip: { ...box, scale: 1 }
    })
    writeFileSync(destination, Buffer.from(screenshot.data, 'base64'))
  } finally {
    await cdp.detach()
  }
}

async function sendFromComposer(page: Page, text: string): Promise<void> {
  const editor = page.locator('[data-native-chat-root="true"] [contenteditable="true"]').first()
  await editor.fill(text)
  await editor.press('Enter')
}

test('Cursor ACP fixture Chat preserves history and loads the exact session after restart', async ({
  seededRepoPath
}, testInfo) => {
  const restart = createRestartSession(testInfo)
  const providerScript = join(restart.userDataDir, 'cursor-acp-fixture.cjs')
  const providerLog = join(restart.userDataDir, 'cursor-acp-fixture-identity.jsonl')
  const controlLog = join(restart.userDataDir, 'cursor-acp-fixture-control.jsonl')
  writeFileSync(providerScript, ACP_FIXTURE)
  const profile = getE2ECompletedOnboardingProfile()
  writeFileSync(
    join(restart.userDataDir, 'orca-data.json'),
    JSON.stringify({
      ...profile,
      settings: {
        ...profile.settings,
        agentStatusHooksEnabled: false,
        experimentalNativeChat: true,
        openAgentTabsInChatByDefault: true,
        agentCmdOverrides: {
          cursor: `${JSON.stringify(process.execPath)} ${JSON.stringify(providerScript)}`
        },
        agentDefaultEnv: {
          cursor: {
            CURSOR_ACP_FIXTURE_LOG: providerLog,
            CURSOR_ACP_FIXTURE_CONTROL_LOG: controlLog
          }
        }
      }
    })
  )
  let active: ElectronApplication | null = null
  try {
    const first = await restart.launch({
      extraEnv: { ORCA_BACKGROUND_LAUNCH: '1', ORCA_DISABLE_CODEX_TRUST_RPC: '1' }
    })
    active = first.app
    await assertHiddenIsolated(first.app)
    const worktreeId = await attachRepoAndOpenTerminal(first.page, seededRepoPath)
    expect(
      await first.page.evaluate(() => window.__store?.getState().settings?.agentStatusHooksEnabled)
    ).toBe(false)
    const sessionId = 'cursor_native_chat_fixture'
    const params = structuredAgentSessionCreateParams({
      sessionId,
      worktree: worktreeId,
      agent: 'cursor',
      randomUuid: () => crypto.randomUUID()
    })
    const result = await first.page.evaluate(async (params) => {
      const response = await window.api.runtime.call({ method: 'agentSession.create', params })
      if (!response.ok) {
        throw new Error(response.error.message)
      }
      return response.result
    }, params)
    expect(z.object({ ok: z.literal(true) }).parse(result).ok).toBe(true)
    expect(JSON.parse(readFileSync(controlLog, 'utf8').trim())).toEqual({
      method: 'fixture/bootstrap',
      homeIsolated: true
    })
    await first.page.getByText('Cursor Chat', { exact: true }).first().click()
    const root = first.page.locator('[data-native-chat-root="true"]')
    await expect(root).toBeVisible()
    await sendFromComposer(first.page, 'Protocol fixture first turn')
    await expect(root.getByText('Protocol fixture first turn', { exact: true })).toHaveCount(2)
    await expect(root).toHaveAttribute('data-native-chat-working', 'false')
    const before = testInfo.outputPath('cursor-acp-chat-before.png')
    await cdpProof(first.page, before)
    await testInfo.attach('Cursor ACP fixture before restart', {
      path: before,
      contentType: 'image/png'
    })
    await restart.close(first.app)
    active = null
    const second = await restart.launch({
      extraEnv: { ORCA_BACKGROUND_LAUNCH: '1', ORCA_DISABLE_CODEX_TRUST_RPC: '1' }
    })
    active = second.app
    await assertHiddenIsolated(second.app)
    await second.page.getByText('Cursor Chat', { exact: true }).first().click()
    await expect(second.page.locator('[data-native-chat-root="true"]')).toBeVisible()
    await expect(second.page.getByText('Protocol fixture first turn', { exact: true })).toHaveCount(
      2
    )
    await sendFromComposer(second.page, 'Protocol fixture continued turn')
    await expect(
      second.page.getByText('Protocol fixture continued turn', { exact: true })
    ).toHaveCount(2)
    const identities = readFileSync(providerLog, 'utf8')
      .trim()
      .split('\n')
      .map((line) =>
        z.object({ method: z.string(), sessionId: z.string() }).parse(JSON.parse(line))
      )
    expect(identities).toEqual([
      { method: 'session/new', sessionId: 'fixture-conversation-1' },
      { method: 'session/load', sessionId: 'fixture-conversation-1' }
    ])
    const identityProof = testInfo.outputPath('cursor-acp-provider-identity.jsonl')
    copyFileSync(providerLog, identityProof)
    await testInfo.attach('Exact Cursor ACP fixture session identity', {
      path: identityProof,
      contentType: 'application/jsonl'
    })
    await expect(second.page.locator('[data-native-chat-root="true"]')).toHaveAttribute(
      'data-native-chat-working',
      'false'
    )
    const after = testInfo.outputPath('cursor-acp-chat-after.png')
    await cdpProof(second.page, after)
    await testInfo.attach('Cursor ACP fixture after restart', {
      path: after,
      contentType: 'image/png'
    })
    await second.page.evaluate(async () => {
      const response = await window.api.runtime.call({
        method: 'agentSession.close',
        params: { sessionId: 'cursor_native_chat_fixture' }
      })
      if (!response.ok) {
        throw new Error(response.error.message)
      }
    })
    const saved = await second.page.evaluate(async () => {
      const response = await window.api.runtime.call({
        method: 'aiVault.listSessions',
        params: { limit: 20 }
      })
      if (!response.ok) {
        throw new Error(response.error.message)
      }
      return response.result
    })
    const history = z
      .object({
        sessions: z.array(
          z.object({
            agent: z.string(),
            sessionId: z.string(),
            cwd: z.string().nullable(),
            structuredSession: z
              .object({ sessionId: z.string(), workspaceId: z.string() })
              .optional(),
            previewMessages: z.array(z.object({ text: z.string() }))
          })
        )
      })
      .parse(saved)
    const owned = history.sessions.find(
      (session) => session.structuredSession?.sessionId === sessionId
    )
    expect(owned).toMatchObject({
      agent: 'cursor',
      sessionId: 'fixture-conversation-1',
      cwd: seededRepoPath
    })
    expect(owned?.previewMessages.map((message) => message.text)).toEqual([
      'Protocol fixture first turn',
      'Protocol fixture first turn',
      'Protocol fixture continued turn',
      'Protocol fixture continued turn'
    ])
    await second.page.evaluate(async (sessionId) => {
      const response = await window.api.runtime.call({
        method: 'agentSession.reveal',
        params: { sessionId }
      })
      if (!response.ok) {
        throw new Error(response.error.message)
      }
    }, sessionId)
    await expect(second.page.locator('[data-native-chat-root="true"]')).toBeVisible()
    await sendFromComposer(second.page, 'Protocol fixture reopened turn')
    await expect(
      second.page.getByText('Protocol fixture reopened turn', { exact: true })
    ).toHaveCount(2)
    const reopened = readFileSync(providerLog, 'utf8')
      .trim()
      .split('\n')
      .map((line) =>
        z.object({ method: z.string(), sessionId: z.string() }).parse(JSON.parse(line))
      )
    expect(reopened).toEqual([
      ...identities,
      { method: 'session/load', sessionId: 'fixture-conversation-1' }
    ])
    copyFileSync(providerLog, identityProof)
    await sendFromComposer(second.page, 'approval')
    const allow = second.page.getByRole('button', { name: 'Allow once', exact: true })
    await expect(allow).toBeVisible()
    const approvalProof = testInfo.outputPath('cursor-acp-chat-approval.png')
    await cdpProof(second.page, approvalProof)
    await testInfo.attach('Cursor ACP fixture tool permission', {
      path: approvalProof,
      contentType: 'image/png'
    })
    await allow.click()
    await expect(second.page.locator('[data-native-chat-root="true"]')).toHaveAttribute(
      'data-native-chat-working',
      'false'
    )
    await sendFromComposer(second.page, 'approval')
    await expect(allow).toBeVisible()
    const stopBefore = testInfo.outputPath('cursor-acp-stop-before.png')
    await cdpProof(second.page, stopBefore)
    await testInfo.attach('Cursor protocol fixture pending approval before Stop', {
      path: stopBefore,
      contentType: 'image/png'
    })
    await second.page
      .locator('[data-native-chat-root="true"]')
      .getByRole('button', { name: 'Cancel', exact: true })
      .click()
    await expect(second.page.locator('[data-native-chat-root="true"]')).toHaveAttribute(
      'data-native-chat-working',
      'false'
    )
    await expect(allow).not.toBeVisible()
    const stopAfter = testInfo.outputPath('cursor-acp-stop-after.png')
    await cdpProof(second.page, stopAfter)
    await testInfo.attach('Cursor protocol fixture cancelled approval after Stop', {
      path: stopAfter,
      contentType: 'image/png'
    })
    const controls = readFileSync(controlLog, 'utf8')
      .trim()
      .split('\n')
      .map((line) =>
        z
          .object({
            method: z.string(),
            outcome: z.string().optional(),
            homeIsolated: z.boolean().optional()
          })
          .parse(JSON.parse(line))
      )
    expect(controls.filter((frame) => frame.method === 'fixture/bootstrap')).toHaveLength(3)
    expect(
      controls
        .filter((frame) => frame.method === 'permission/response')
        .map((frame) => frame.outcome)
    ).toEqual(['selected', 'cancelled'])
    expect(controls.slice(-2)).toEqual([
      { method: 'session/cancel' },
      { method: 'permission/response', outcome: 'cancelled' }
    ])
    const stopTrace = testInfo.outputPath('cursor-acp-stop-control.jsonl')
    copyFileSync(controlLog, stopTrace)
    await testInfo.attach('Cursor protocol fixture Stop and mandatory cancelled response', {
      path: stopTrace,
      contentType: 'application/jsonl'
    })
    await sendFromComposer(second.page, 'Protocol fixture after stopped approval')
    await expect(
      second.page.getByText('Protocol fixture after stopped approval', { exact: true })
    ).toHaveCount(2)
  } finally {
    if (active) {
      await restart.close(active)
    }
    await restart.dispose()
  }
})
