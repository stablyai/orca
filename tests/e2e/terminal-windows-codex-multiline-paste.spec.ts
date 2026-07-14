import { test, expect } from './helpers/orca-app'
import {
  focusActiveTerminalInput,
  getTerminalContent,
  sendToTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForTerminalOutput
} from './helpers/terminal'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'

const DRAFT = 'ORCA_CODEX_PASTE_DRAFT_SHOULD_STAY_UNSENT'
const CODEX_TRUST_PROMPT_RE = /Do[\s\S]*you[\s\S]*trust[\s\S]*contents/i

function pastePayload(): string {
  const lines = [
    'Repository: stablyai/orca',
    '',
    'Required exact revision:',
    '',
    '0123456789abcdef0123456789abcdef01234567',
    '',
    'This is validation only:',
    '',
    '- Do not modify files.',
    '',
    '- Do not commit or push.',
    '',
    '- If the worktree is dirty before starting, stop and report it.',
    '',
    '- Use native Windows PowerShell, Node 24, and pnpm 10.',
    '',
    '- Confirm the checked-out full SHA before testing.',
    '',
    'Run:',
    '',
    '1. pnpm typecheck',
    '',
    '2. pnpm lint',
    '',
    '3. Run the focused Node 24 suite and report every result.',
    '',
    '4. Run the registered Electron gate exactly as written.',
    '',
    'If anything fails, include the first useful stack trace and distinguish product failure from test-harness or environmental failure.'
  ]
  return Array.from({ length: 4 }, () => lines.join('\r\n')).join('\r\n\r\n')
}

async function enableTerminalAccessibilityDom(
  page: Parameters<typeof focusActiveTerminalInput>[0],
  ptyId: string
): Promise<void> {
  await page.evaluate((targetPtyId) => {
    const managers = Array.from(window.__paneManagers?.values() ?? [])
    const pane = managers
      .flatMap((manager) => manager.getPanes?.() ?? [])
      .find((candidate) => candidate.container.dataset.ptyId === targetPtyId)
    if (!pane) {
      throw new Error(`Terminal pane ${targetPtyId} is unavailable`)
    }
    // Why: xterm paints to canvas by default. Screen-reader mode mirrors the
    // visible prompt into DOM rows so the regression assertions stay user-facing.
    pane.terminal.options.screenReaderMode = true
    pane.terminal.refresh(0, pane.terminal.rows - 1)
  }, ptyId)
  await expect(
    page.locator(`[data-pty-id=${JSON.stringify(ptyId)}] .xterm-accessibility-tree`)
  ).toBeAttached({ timeout: 10_000 })
}

test.describe('Windows Codex multiline paste', () => {
  test.use({ seedTestRepo: false })

  test('multiline Ctrl+V keeps the existing Codex draft unsent @local-real-codex', async ({
    orcaPage,
    testRepoPath
  }) => {
    test.skip(process.platform !== 'win32', 'Windows ConPTY coverage is Windows-only')
    test.skip(
      process.env.ORCA_E2E_REAL_CODEX !== '1',
      'Set ORCA_E2E_REAL_CODEX=1 to exercise the locally installed Codex TUI'
    )
    test.slow()

    await waitForSessionReady(orcaPage)
    await orcaPage.evaluate(async (repoPath) => {
      const normalizePath = (value: string): string => value.replaceAll('\\', '/').toLowerCase()
      await window.api.repos.add({ path: repoPath })
      const store = window.__store
      if (!store) {
        throw new Error('Orca store unavailable')
      }
      await store.getState().fetchRepos()
      const repo = store
        .getState()
        .repos.find((candidate) => normalizePath(candidate.path) === normalizePath(repoPath))
      if (!repo) {
        throw new Error('Seeded repository unavailable')
      }
      await store.getState().updateRepo(repo.id, { externalWorktreeVisibility: 'show' })
      await store.getState().fetchWorktrees(repo.id)
      const worktree = store
        .getState()
        .worktreesByRepo[repo.id]?.find(
          (candidate) => normalizePath(candidate.path) === normalizePath(repoPath)
        )
      if (!worktree) {
        throw new Error('Seeded worktree unavailable')
      }
      store.getState().setActiveWorktree(worktree.id)
      store.getState().createTab(worktree.id)
    }, testRepoPath)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)

    const ptyId = await waitForActivePanePtyId(orcaPage)
    await sendToTerminal(orcaPage, ptyId, 'codex -m orca-e2e-invalid-model\r')
    await expect
      .poll(() => getTerminalContent(orcaPage, 12_000), { timeout: 20_000 })
      .toMatch(/Do[\s\S]*you[\s\S]*trust[\s\S]*contents|OpenAI Codex/i)
    if (CODEX_TRUST_PROMPT_RE.test(await getTerminalContent(orcaPage, 12_000))) {
      await sendToTerminal(orcaPage, ptyId, '\r')
    }
    await waitForTerminalOutput(orcaPage, 'OpenAI Codex', 20_000, 30_000)
    await enableTerminalAccessibilityDom(orcaPage, ptyId)
    await focusActiveTerminalInput(orcaPage)
    await orcaPage.keyboard.type(DRAFT)
    const terminalDom = orcaPage.locator(
      `[data-pty-id=${JSON.stringify(ptyId)}] .xterm-accessibility-tree`
    )
    await expect(terminalDom).toContainText(DRAFT, { timeout: 10_000 })
    await orcaPage.evaluate((text) => window.api.ui.writeClipboardText(text), pastePayload())

    await orcaPage.keyboard.press('Control+V')
    await expect(terminalDom).toContainText('[Pasted Content', { timeout: 10_000 })
    await expect(terminalDom).toContainText(DRAFT)
    await orcaPage.waitForTimeout(2_000)
    await expect(terminalDom).not.toContainText('Working')
    await expect(terminalDom).not.toContainText('unexpected status 404')
  })
})
