import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import { runProcess } from '../../src/shared/child-process/run-process'
import { resolveManagedOrcaCliCommand } from '../../src/main/cli/managed-orca-cli-command'
import { expect, test } from './helpers/orca-app'
import { ensureTerminalVisible, waitForSessionReady } from './helpers/store'
import { waitForActivePaneHookDescriptor } from './helpers/terminal'

test('agent browser commands create and control the native canvas card without switching tabs', async ({
  orcaPage,
  electronApp
}, testInfo) => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html' })
    response.end(
      "<!doctype html><title>Agent browser</title><h1>Ready</h1><button onclick=\"document.querySelector('h1').textContent='Controlled by agent'\">Run check</button>"
    )
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
    await waitForSessionReady(orcaPage)
    await ensureTerminalVisible(orcaPage)
    const pane = await waitForActivePaneHookDescriptor(orcaPage)
    await orcaPage.evaluate((pane) => {
      const state = window.__store!.getState()
      if (!state.settings) {
        throw new Error('Settings have not loaded')
      }
      window.__store!.setState({
        settings: {
          ...state.settings,
          experimentalAgentDashboardShowIdle: true,
          tabAutoGenerateTitle: false
        }
      })
      state.setAgentStatus(
        pane.paneKey,
        { state: 'working', prompt: 'Check the browser', agentType: 'codex' },
        'Codex',
        { updatedAt: Date.now(), stateStartedAt: Date.now() },
        {
          tabId: pane.paneKey.split(':')[0],
          terminalHandle: 'canvas-browser-agent',
          worktreeId: pane.worktreeId
        }
      )
    }, pane)
    await orcaPage.getByRole('button', { name: 'New tab', exact: true }).click()
    await orcaPage.getByRole('menuitem', { name: 'New Canvas', exact: true }).click()
    await orcaPage.getByRole('combobox', { name: 'New agent', exact: true }).click()
    await expect(orcaPage.getByPlaceholder('Search agents...')).toBeFocused()
    await expect(orcaPage.getByRole('button', { name: 'Manage agents', exact: true })).toBeVisible()
    await orcaPage.getByRole('dialog').screenshot({
      path: testInfo.outputPath('canvas-agent-selector.png'),
      animations: 'disabled'
    })
    await orcaPage.getByPlaceholder('Search agents...').press('Escape')
    await orcaPage.getByRole('button', { name: 'Attach a workspace session', exact: true }).click()
    await orcaPage
      .getByRole('group', { name: 'Attach a workspace session' })
      .getByRole('option')
      .first()
      .click()
    await expect(orcaPage.locator('[data-canvas-kind="agent"]')).toBeVisible()
    const userDataPath = await electronApp.evaluate(({ app }) => app.getPath('userData'))
    const command = resolveManagedOrcaCliCommand({ isPackaged: false, userDataPath })
    if (!command) {
      throw new Error('The app did not install its managed CLI launcher')
    }
    const foreignBin = testInfo.outputPath('foreign-cli')
    await mkdir(foreignBin, { recursive: true })
    await writeFile(
      join(foreignBin, process.platform === 'win32' ? 'orca.cmd' : 'orca'),
      process.platform === 'win32' ? '@echo off\r\nexit /b 91\r\n' : '#!/bin/sh\nexit 91\n',
      { mode: 0o755 }
    )
    const cliEnv = {
      ...Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !key.startsWith('ORCA_'))
      ),
      ORCA_USER_DATA_PATH: userDataPath,
      ORCA_PANE_KEY: pane.paneKey,
      PATH: `${foreignBin}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}`
    }
    const runCli = async (args: string[]) => {
      const processResult = await runProcess({
        program: command,
        args: [...args, '--json'],
        env: cliEnv,
        timeoutMs: 60_000
      })
      if (processResult.code !== 0) {
        throw new Error(processResult.stderr || processResult.stdout)
      }
      return JSON.parse(processResult.stdout)
    }
    const result = await runCli([
      'tab',
      'create',
      '--url',
      url,
      '--worktree',
      `id:${pane.worktreeId}`
    ])
    if (!result.ok) {
      throw new Error(JSON.stringify(result))
    }
    const pageId = (result.result as { browserPageId: string }).browserPageId
    await testInfo.attach('canvas-browser-routing.json', {
      contentType: 'application/json',
      body: JSON.stringify(
        await orcaPage.evaluate(() => ({
          tabs: window.__store!.getState().unifiedTabsByWorktree,
          documents: Object.keys(localStorage)
            .filter((key) => key.startsWith('orca.agent-canvas.v1:'))
            .map((key) => [key, localStorage.getItem(key)])
        }))
      )
    })
    const card = orcaPage.locator('[data-canvas-kind="browser"]')
    await expect(card).toBeVisible()
    await expect(orcaPage.locator('.react-flow__edge')).toHaveCount(1)
    await expect(orcaPage.locator('[data-workspace-canvas]')).toBeVisible()
    await orcaPage.getByRole('button', { name: 'Fit canvas', exact: true }).click()
    const browserId = await card
      .locator('[data-canvas-browser]')
      .getAttribute('data-canvas-browser')
    const guest = orcaPage.locator(`[data-browser-overlay-tab-id="${browserId}"] webview`)
    await expect(guest).toBeVisible()
    const heading = () =>
      guest.evaluate((element) =>
        (element as Electron.WebviewTag).executeJavaScript(
          'document.querySelector("h1")?.textContent'
        )
      )
    await expect.poll(heading).toBe('Ready')
    await runCli(['click', '--page', pageId, '--element', 'button'])
    await expect.poll(heading).toBe('Controlled by agent')
    await orcaPage.screenshot({ path: testInfo.outputPath('canvas-browser-agent-control.png') })
    const cdp = await orcaPage.context().newCDPSession(orcaPage)
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 900,
      height: 700,
      deviceScaleFactor: 1,
      mobile: false
    })
    await orcaPage.getByRole('button', { name: 'Fit canvas', exact: true }).click()
    await expect(
      orcaPage.getByRole('combobox', { name: 'New agent', exact: true })
    ).toBeInViewport()
    await orcaPage.screenshot({ path: testInfo.outputPath('canvas-browser-narrow.png') })
    await cdp.detach()
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    )
  }
})
