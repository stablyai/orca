import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from './helpers/orca-app'

const capture = process.env.ORCA_REAL_DSH_HISTORY_PROOF
const proof = capture ? JSON.parse(readFileSync(capture, 'utf8')) : null
const artifact = proof?.session ?? proof
const dshHome = process.env.ORCA_REAL_DSH_HOME ?? ''
const runtimeBin = process.env.ORCA_REAL_DSH_BIN ?? ''
test.use({
  orcaAppInitialSettings: { agentStatusHooksEnabled: false },
  orcaAppExtraEnv: {
    DSH_HOME: dshHome,
    PATH: `${runtimeBin}${path.delimiter}${process.env.PATH ?? ''}`,
    DEEPSEEK_API_KEY: '',
    ORCA_BACKGROUND_LAUNCH: '1',
    ORCA_E2E_HEADLESS: '1'
  }
})
test.skip(
  !capture || !dshHome || !runtimeBin,
  'Opt-in actual official DSH capture and task-owned binary required'
)

test('actual official DSH persistence opens, searches and resumes in a folder workspace', async ({
  orcaPage,
  electronApp
}, testInfo) => {
  const cdp = await orcaPage.context().newCDPSession(orcaPage)
  const folder = artifact.cwd
  await orcaPage.evaluate(async (cwd) => {
    const state = window.__store!.getState()
    const repo = await state.addNonGitFolder(cwd)
    if (!repo) {
      throw new Error('Could not add task-owned folder')
    }
    const worktree = window.__store!.getState().worktreesByRepo[repo.id]?.[0]
    if (!worktree) {
      throw new Error('Folder workspace missing')
    }
    window.__store!.getState().setActiveWorktree(worktree.id)
    window.__store!.getState().setRightSidebarOpen(true)
    window.__store!.getState().setRightSidebarTab('vault')
    window.__store!.getState().setRightSidebarWidth(450)
  }, folder)
  const sessions = await orcaPage.evaluate(async () =>
    window.api.aiVault.listSessions({ executionHostScope: 'local', limit: 100 })
  )
  const session = sessions.sessions.find(
    (value) => value.agent === 'dsh' && value.sessionId === artifact.sessionId
  )
  expect(session).toMatchObject({
    agent: 'dsh',
    messageCount: 1,
    model: 'deepseek-flash',
    cwd: folder
  })
  if (!session) {
    throw new Error('Actual DSH capture was not discovered')
  }
  const prompt = await orcaPage.evaluate(
    async (s) =>
      window.api.aiVault.getFirstUserPrompt({
        agent: s.agent,
        filePath: s.filePath!,
        sessionId: s.sessionId,
        executionHostId: s.executionHostId
      }),
    session
  )
  expect(prompt.prompt).toBe('DSH history proof: inspect this folder without generating an answer.')
  writeFileSync(
    testInfo.outputPath('actual-ipc.json'),
    JSON.stringify({ session, prompt }, null, 2)
  )
  await orcaPage.getByRole('button', { name: 'Refresh Session History', exact: true }).click()
  await orcaPage.getByText('DSH history proof: inspect this', { exact: true }).click()
  await expect(orcaPage.getByText(prompt.prompt!, { exact: true }).first()).toBeVisible()
  async function screenshot(name: string) {
    const clip =
      name.includes('preview') || name.includes('search')
        ? {
            x: await orcaPage.evaluate(() => window.innerWidth - 450),
            y: 35,
            width: 450,
            height: 720,
            scale: 1
          }
        : undefined
    const { data } = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      ...(clip ? { clip } : {})
    })
    const target = testInfo.outputPath(name)
    writeFileSync(target, Buffer.from(data, 'base64'))
    await testInfo.attach(name, { path: target, contentType: 'image/png' })
  }
  await screenshot('actual-history-preview.png')
  const openLog = orcaPage.getByRole('button', { name: /(?:Open|View) Log/i })
  await openLog.click()
  await expect(orcaPage.locator('.monaco-editor')).toBeVisible()
  const decoded = await orcaPage.evaluate(
    async (filePath) => window.api.fs.readFile({ filePath, decodeDshHistory: true }),
    session.filePath!
  )
  expect(decoded.decodedDshHistory).toBe(true)
  expect(decoded.content).toContain('DSH history proof: inspect this folder')
  writeFileSync(testInfo.outputPath('decoded-log.jsonl'), decoded.content)
  await screenshot('actual-decoded-log.png')
  const exported = testInfo.outputPath('session.v4.decoded.jsonl')
  await electronApp.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath })
  }, exported)
  await orcaPage.locator('.editor-header-path-row').click({ button: 'right' })
  await orcaPage.getByRole('menuitem', { name: 'Export decoded DSH log…', exact: true }).click()
  await expect
    .poll(() => {
      try {
        return readFileSync(exported, 'utf8')
      } catch {
        return ''
      }
    })
    .toBe(decoded.content)
  const input = orcaPage.getByRole('textbox', { name: 'Search sessions', exact: true })
  await input.fill('history proof')
  await orcaPage.getByRole('button', { name: 'Enable', exact: true }).click()
  await expect
    .poll(
      () =>
        orcaPage.evaluate(
          async () => (await window.api.aiVault.searchStatus('local')).filesIndexed
        ),
      { timeout: 30_000 }
    )
    .toBeGreaterThan(0)
  await orcaPage.getByRole('button', { name: 'Refresh Session History', exact: true }).click()
  await expect(
    orcaPage
      .locator('mark')
      .filter({ hasText: /history proof/i })
      .first()
  ).toBeVisible()
  await screenshot('actual-indexed-search.png')
  await input.fill('')
  const toggle = orcaPage.getByTestId('ai-vault-session-toggle-details')
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') {
    await toggle.click()
  }
  const resume = orcaPage
    .locator('[id^="ai-vault-session-details-"]')
    .getByRole('button', { name: 'Resume in Worktree', exact: true })
  await resume.click()
  await expect
    .poll(
      () =>
        orcaPage.evaluate(() => {
          const panes = window.__paneManagers
          return panes
            ? Array.from(panes.values())
                .flatMap((manager) => manager.getPanes())
                .map((pane) => {
                  const buffer = pane.terminal.buffer.active
                  return Array.from(
                    { length: buffer.length },
                    (_, i) => buffer.getLine(i)?.translateToString(true) ?? ''
                  ).join('\n')
                })
                .join('\n')
            : ''
        }),
      { timeout: 30_000 }
    )
    .toContain('DSH history proof')
  await screenshot('actual-exact-resume.png')
  expect(
    await electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().every((window) => !window.isVisible())
    )
  ).toBe(true)
  await cdp.detach()
})
