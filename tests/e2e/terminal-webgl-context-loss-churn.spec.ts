import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import {
  getActiveTabId,
  switchToOtherWorktree,
  switchToWorktree,
  waitForActiveWorktree,
  waitForSessionReady
} from './helpers/store'
import {
  execInTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForTerminalOutput
} from './helpers/terminal'

type RenderingState = {
  hasWebgl: boolean
  domRows: boolean
}

async function forceWebgl(page: Page, tabId: string): Promise<void> {
  await page.evaluate((id) => {
    const state = window.__store?.getState()
    if (state?.settings) {
      window.__store?.setState({
        settings: { ...state.settings, terminalGpuAcceleration: 'on' }
      })
    }
    window.__paneManagers?.get(id)?.setTerminalGpuAcceleration?.('on')
  }, tabId)
  await expect.poll(() => renderingState(page, tabId)).toMatchObject({ hasWebgl: true })
}

async function renderingState(page: Page, tabId: string): Promise<RenderingState> {
  return page.evaluate((id) => {
    const manager = window.__paneManagers?.get(id)
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
    return {
      hasWebgl: manager?.getRenderingDiagnostics?.().some((item) => item.hasWebgl) ?? false,
      domRows: Boolean(pane?.container.querySelector('.xterm-rows'))
    }
  }, tabId)
}

async function loseActiveWebglContext(page: Page, tabId: string): Promise<void> {
  const lost = await page.evaluate((id) => {
    const manager = window.__paneManagers?.get(id)
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
    const canvases = Array.from(pane?.container.querySelectorAll('canvas') ?? [])
    const extension = canvases
      .map((canvas) => {
        const gl =
          (canvas.getContext('webgl2') as WebGL2RenderingContext | null) ??
          (canvas.getContext('webgl') as WebGLRenderingContext | null)
        return gl?.getExtension('WEBGL_lose_context') ?? null
      })
      .find((candidate) => candidate !== null)
    extension?.loseContext()
    return Boolean(extension)
  }, tabId)
  expect(lost, 'active xterm canvas exposes WEBGL_lose_context').toBe(true)
  await expect
    .poll(() => renderingState(page, tabId), { timeout: 8_000 })
    .toMatchObject({ hasWebgl: false, domRows: true })
}

async function hideAndRevealWorktree(
  page: Page,
  activeWorktreeId: string,
  tabId: string
): Promise<void> {
  const other = await switchToOtherWorktree(page, activeWorktreeId)
  expect(other, 'seeded E2E repo provides a second worktree').not.toBeNull()
  await expect
    .poll(() => page.evaluate(() => window.__store?.getState().activeWorktreeId))
    .toBe(other)
  await switchToWorktree(page, activeWorktreeId)
  await expect
    .poll(() => page.evaluate(() => window.__store?.getState().activeWorktreeId))
    .toBe(activeWorktreeId)
  await expect
    .poll(() => page.evaluate((id) => Boolean(window.__paneManagers?.get(id)), tabId))
    .toBe(true)
}

async function domContains(page: Page, tabId: string, marker: string): Promise<boolean> {
  return page.evaluate(
    ({ id, marker }) => {
      const manager = window.__paneManagers?.get(id)
      const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
      return pane?.container.querySelector('.xterm-rows')?.textContent?.includes(marker) ?? false
    },
    { id: tabId, marker }
  )
}

test.describe('terminal WebGL context-loss churn @headful', () => {
  test('pins the repeatedly lossy pane to visible DOM output', async ({
    electronApp,
    orcaPage
  }, testInfo) => {
    const pid = electronApp.process().pid
    const debuggingArg = electronApp
      .process()
      .spawnargs.find((arg) => arg.startsWith('--remote-debugging-port='))
    console.log(`[webgl-churn] electronPid=${pid} ${debuggingArg ?? 'playwright-ephemeral-cdp'}`)

    await waitForSessionReady(orcaPage)
    await waitForActiveTerminalManager(orcaPage)
    const worktreeId = await waitForActiveWorktree(orcaPage)
    const tabId = (await getActiveTabId(orcaPage))!
    const ptyId = await waitForActivePanePtyId(orcaPage)
    await forceWebgl(orcaPage, tabId)

    await execInTerminal(
      orcaPage,
      ptyId,
      `node -e "let i=0;const t=setInterval(()=>{console.log('WEBGL_CHURN_'+(++i));if(i===140)clearInterval(t)},100)"`
    )
    await waitForTerminalOutput(orcaPage, 'WEBGL_CHURN_2')
    await testInfo.attach('webgl-before-loss', {
      body: await orcaPage.locator('.xterm:visible').first().screenshot(),
      contentType: 'image/png'
    })

    for (let loss = 1; loss <= 3; loss += 1) {
      await loseActiveWebglContext(orcaPage, tabId)
      await expect.poll(() => domContains(orcaPage, tabId, 'WEBGL_CHURN_')).toBe(true)
      await hideAndRevealWorktree(orcaPage, worktreeId, tabId)
      if (loss < 3) {
        await expect.poll(() => renderingState(orcaPage, tabId)).toMatchObject({ hasWebgl: true })
      }
    }

    await orcaPage.evaluate(() => window.dispatchEvent(new Event('focus')))
    await waitForTerminalOutput(orcaPage, 'WEBGL_CHURN_140')
    const finalState = await renderingState(orcaPage, tabId)
    expect(finalState).toEqual({ hasWebgl: false, domRows: true })
    await expect.poll(() => domContains(orcaPage, tabId, 'WEBGL_CHURN_140')).toBe(true)

    const domBurstStartedAt = performance.now()
    await execInTerminal(
      orcaPage,
      ptyId,
      `node -e "for(let i=0;i<1000;i++)console.log('DOM_BURST_'+i)"`
    )
    await waitForTerminalOutput(orcaPage, 'DOM_BURST_999')
    await expect.poll(() => domContains(orcaPage, tabId, 'DOM_BURST_999')).toBe(true)
    const domBurstMs = performance.now() - domBurstStartedAt
    console.log(`[webgl-churn] visibleDomBurst1000Ms=${domBurstMs.toFixed(1)}`)
    expect(
      domBurstMs,
      '1,000 PTY lines must remain interactively visible in DOM mode'
    ).toBeLessThan(10_000)
    await testInfo.attach('dom-after-pin', {
      body: await orcaPage.locator('.xterm:visible').first().screenshot(),
      contentType: 'image/png'
    })
  })
})
