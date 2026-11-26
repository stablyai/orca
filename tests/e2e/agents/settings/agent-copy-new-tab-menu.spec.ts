// An agent copy in the + menu: its own row and submenu, as its base agent has, launching the copy.
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect } from '@stablyai/playwright-test'
import { test } from '../../desktop/electron-fixtures/orca-app'
import { getGoldenStubAgentLaunchEnv } from '../../golden-journeys/golden-stub-agent'
import { waitForActiveWorktree, waitForSessionReady } from '../../desktop/renderer-probes/store'
import { waitForTerminalOutput } from '../../terminal/layout/terminal-pane-operations'

test.skip(process.platform === 'win32', 'the copy wrapper is a POSIX shell script')
// The fixture's stub `claude` makes Claude a detected agent, so the + menu lists it and its copy.
test.use({ launchEnv: getGoldenStubAgentLaunchEnv() })

let wrapperDir: string | null = null

test.afterEach(() => {
  if (wrapperDir) {
    rmSync(wrapperDir, { recursive: true, force: true })
    wrapperDir = null
  }
})

test('an agent copy has its own submenu in the + menu and launches as the copy', async ({
  orcaPage: page
}) => {
  // Two agent launches after a cold Orca start; the default 60s is too tight on CI.
  test.setTimeout(180_000)
  // A terminal shows the environment the copy started with.
  wrapperDir = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-agent-copy-'))
  const wrapper = path.join(wrapperDir, 'claude-code-mode')
  writeFileSync(
    wrapper,
    [
      '#!/bin/sh',
      'echo "COPY_ENV CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=${CLAUDE_CODE_EXPERIMENTAL_CODE_MODE:-unset} args: $*"',
      'exec cat > /dev/null',
      ''
    ].join('\n')
  )
  chmodSync(wrapper, 0o755)
  await waitForSessionReady(page)
  await waitForActiveWorktree(page)
  await page.evaluate(async (command) => {
    await window.__store?.getState().updateSettings({
      agentDefaultSurface: 'terminal',
      defaultTuiAgent: 'claude',
      agentCopies: [
        {
          id: 'claude.claude-code-mode',
          name: 'Claude Code Mode',
          agent: 'claude',
          command,
          args: '',
          env: { CLAUDE_CODE_EXPERIMENTAL_CODE_MODE: '1' }
        }
      ]
    })
  }, wrapper)

  await page.getByRole('button', { name: 'New tab' }).click({ force: true })
  const configure = page.getByRole('button', { name: 'Configure Claude Code Mode' })
  await expect(configure).toBeVisible({ timeout: 20_000 })
  await expect(page.getByRole('button', { name: 'Configure Claude', exact: true })).toBeVisible()
  // No flat surface-only row next to the submenu.
  await expect(page.getByRole('menuitem', { name: 'Claude Code Mode (CLI)' })).toHaveCount(0)

  await configure.click({ force: true })
  await expect(
    page.getByRole('combobox', { name: 'Search models' }).or(page.getByLabel('Search models'))
  ).toBeVisible({ timeout: 20_000 })
  // The panel launches the copy with the model picked there.
  await page.getByText('Haiku', { exact: true }).click({ force: true })
  await page.getByRole('button', { name: /Launch terminal/ }).click({ force: true })
  await waitForTerminalOutput(page, 'COPY_ENV CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1 args: ', 30_000)
  await waitForTerminalOutput(page, 'haiku', 10_000)

  // The row itself launches the copy on its default surface (CLI here).
  await page.getByRole('button', { name: 'New tab' }).click({ force: true })
  const row = page.locator('[data-agent-launch-row]').filter({ hasText: 'Claude Code Mode' })
  await expect(row).toBeVisible({ timeout: 20_000 })
  await row.click({ force: true })
  await waitForTerminalOutput(page, 'COPY_ENV CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1', 30_000)
})
