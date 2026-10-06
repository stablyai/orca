import { writeFile } from 'node:fs/promises'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { waitForActivePaneHookDescriptor, waitForActiveTerminalManager } from './helpers/terminal'

const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAYUlEQVR4nO3PIREAIBAAMFqhMWgyUYMun4QQaBQZEO92twIrZ/RUde1URUBAQEBAQEBAQEBAQEBAQEBAQEBAQEDgO9BiprrRUgkICAgICAgICAgICAgICAgICAgICAgIfHuebLmH1pKnMwAAAABJRU5ErkJggg=='

test('OMP composer accepts an image clipboard event', async ({
  orcaPage,
  electronApp
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage)
  const descriptor = await waitForActivePaneHookDescriptor(orcaPage)
  const imagePath = testInfo.outputPath('omp-image-proof.png')
  await writeFile(imagePath, Buffer.from(PNG, 'base64'))
  await orcaPage.evaluate(async ({ paneKey, worktreeId }) => {
    const settings = await window.api.settings.set({ experimentalNativeChat: true })
    const store = window.__store
    if (!store) {
      throw new Error('Store unavailable')
    }
    store.setState({ settings })
    const state = store.getState()
    state.setAgentStatus(
      paneKey,
      { state: 'idle', agentType: 'omp', prompt: '' },
      'OMP',
      undefined,
      { worktreeId }
    )
    const [tabId] = paneKey.split(':')
    const tab = (state.unifiedTabsByWorktree[worktreeId] ?? []).find(
      (candidate) => candidate.contentType === 'terminal' && candidate.entityId === tabId
    )
    if (!tab) {
      throw new Error('Terminal tab unavailable')
    }
    state.toggleTabViewMode(tab.id)
  }, descriptor)
  const composer = orcaPage.getByRole('textbox', { name: 'Send a message…', exact: true })
  await expect(composer).toBeVisible()
  // Substitute only clipboard persistence; never overwrite the user's system clipboard.
  await electronApp.evaluate(
    ({ ipcMain }, { imagePath }) => {
      ipcMain.removeHandler('clipboard:saveImageAsTempFile')
      ipcMain.handle('clipboard:saveImageAsTempFile', () => imagePath)
    },
    { imagePath }
  )
  await composer.evaluate((element, png) => {
    const data = new DataTransfer()
    const bytes = Uint8Array.from(atob(png), (character) => character.charCodeAt(0))
    data.items.add(new File([bytes], 'omp-image-proof.png', { type: 'image/png' }))
    element.dispatchEvent(
      new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data })
    )
  }, PNG)
  await expect(
    orcaPage.getByRole('img', { name: 'omp-image-proof.png', exact: true })
  ).toBeVisible()
  await orcaPage.screenshot({ path: testInfo.outputPath('omp-image-attached.png') })
})
