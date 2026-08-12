import { createHash } from 'node:crypto'
import type { Page } from '@stablyai/playwright-test'
import { connectDockerSshRelayTarget } from './helpers/docker-ssh-relay-connection'
import {
  cleanupDockerSshRelayTarget,
  DOCKER_SSH_RELAY_REMOTE_REPO_PATH,
  execDockerSshRelayTargetCommand,
  shellQuote,
  startDockerSshRelayTarget,
  type DockerSshRelayTarget
} from './helpers/docker-ssh-relay-target'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  getTerminalContent,
  sendToTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager
} from './helpers/terminal'

const RUN_DOCKER_SSH = process.env.ORCA_E2E_SSH_DOCKER === '1'
const REMOTE_IMAGE_PATH = '/tmp/orca-ssh-external-preview.png'
const IMAGE_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR4AWN8z8DwnwEJMDGgAcICAO2mBAXmO4drAAAAAElFTkSuQmCC'

type LinkProbe = { col: number; row: number; tabId: string }

async function findTerminalLink(page: Page, text: string): Promise<LinkProbe> {
  return page.evaluate((text) => {
    const state = window.__store?.getState()
    const tabId = state?.activeTabId ?? null
    const manager = tabId ? window.__paneManagers?.get(tabId) : null
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
    if (!tabId || !pane) {
      throw new Error('Active terminal pane is unavailable')
    }
    const terminal = pane.terminal
    for (let row = 0; row < terminal.rows; row += 1) {
      const line = terminal.buffer.active.getLine(terminal.buffer.active.viewportY + row)
      const col = line?.translateToString(true).indexOf(text) ?? -1
      if (col >= 0) {
        return { col: col + Math.floor(text.length / 2), row, tabId }
      }
    }
    throw new Error('External image path is not visible in the terminal')
  }, text)
}

async function activateTerminalLink(page: Page, probe: LinkProbe, text: string): Promise<void> {
  await expect
    .poll(
      async () => {
        await page.evaluate(({ col, row, tabId }) => {
          const manager = window.__paneManagers?.get(tabId)
          const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
          const screen = pane?.terminal.element?.querySelector<HTMLElement>('.xterm-screen')
          if (!pane || !screen) {
            throw new Error('Active terminal screen is unavailable')
          }
          const rect = screen.getBoundingClientRect()
          screen.dispatchEvent(
            new MouseEvent('mousemove', {
              bubbles: true,
              cancelable: true,
              clientX: rect.left + (col + 0.5) * (rect.width / pane.terminal.cols),
              clientY: rect.top + (row + 0.5) * (rect.height / pane.terminal.rows)
            })
          )
        }, probe)
        return page.evaluate((tabId) => {
          const manager = window.__paneManagers?.get(tabId)
          const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
          const core = pane?.terminal as unknown as
            | { _core?: { linkifier?: { currentLink?: { link?: { text?: string } } } } }
            | undefined
          return core?._core?.linkifier?.currentLink?.link?.text ?? null
        }, probe.tabId)
      },
      { timeout: 10_000, message: 'External SSH image path did not become clickable' }
    )
    .toContain(text)

  await page.evaluate(({ col, row, tabId }) => {
    const manager = window.__paneManagers?.get(tabId)
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
    const screen = pane?.terminal.element?.querySelector<HTMLElement>('.xterm-screen')
    if (!pane || !screen) {
      throw new Error('Active terminal screen is unavailable')
    }
    const rect = screen.getBoundingClientRect()
    const mouse = {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX: rect.left + (col + 0.5) * (rect.width / pane.terminal.cols),
      clientY: rect.top + (row + 0.5) * (rect.height / pane.terminal.rows),
      metaKey: navigator.userAgent.includes('Mac'),
      ctrlKey: !navigator.userAgent.includes('Mac')
    }
    screen.dispatchEvent(new MouseEvent('mousedown', { ...mouse, buttons: 1 }))
    screen.dispatchEvent(new MouseEvent('mouseup', mouse))
  }, probe)
}

test.describe('SSH external image preview', () => {
  test.skip(!RUN_DOCKER_SSH, 'Set ORCA_E2E_SSH_DOCKER=1 to run Docker-backed SSH tests.')
  test.skip(process.platform === 'win32', 'The disposable SSH host uses POSIX tooling.')

  test('opens an image outside the worktree from a terminal link', async ({
    orcaPage,
    registerPostElectronShutdownCleanup
  }, testInfo) => {
    test.slow()
    let target: DockerSshRelayTarget | null = null
    let cleanupDeferred = false
    try {
      target = startDockerSshRelayTarget(testInfo)
      registerPostElectronShutdownCleanup(async () => cleanupDockerSshRelayTarget(target))
      cleanupDeferred = true
      execDockerSshRelayTargetCommand(
        target,
        `printf '%s' ${shellQuote(IMAGE_BASE64)} | base64 -d > ${shellQuote(REMOTE_IMAGE_PATH)}`
      )

      await waitForSessionReady(orcaPage)
      await waitForActiveWorktree(orcaPage)
      const remote = await connectDockerSshRelayTarget(orcaPage, target, {
        remotePath: DOCKER_SSH_RELAY_REMOTE_REPO_PATH
      })
      await ensureTerminalVisible(orcaPage, 45_000)
      await waitForActiveTerminalManager(orcaPage, 60_000)
      const ptyId = await waitForActivePanePtyId(orcaPage, 60_000)
      const readyMarker = `SSH_PREVIEW_READY_${Date.now()}`
      const encodedReadyMarker = Buffer.from(readyMarker).toString('base64')
      await sendToTerminal(
        orcaPage,
        ptyId,
        `printf '%s' ${shellQuote(encodedReadyMarker)} | base64 -d; printf '\\n'\r`
      )
      await expect
        .poll(() => getTerminalContent(orcaPage, 30_000), {
          timeout: 15_000,
          message: 'SSH terminal did not execute the readiness marker'
        })
        .toContain(readyMarker)

      await sendToTerminal(orcaPage, ptyId, `printf '%s\\n' ${shellQuote(REMOTE_IMAGE_PATH)}\r`)
      await expect
        .poll(() => getTerminalContent(orcaPage, 30_000), {
          timeout: 15_000,
          message: 'External image path did not reach the SSH terminal'
        })
        .toContain(REMOTE_IMAGE_PATH)

      const probe = await findTerminalLink(orcaPage, REMOTE_IMAGE_PATH)
      await activateTerminalLink(orcaPage, probe, REMOTE_IMAGE_PATH)

      const preview = orcaPage.locator(`img[alt="${REMOTE_IMAGE_PATH.split('/').at(-1)}"]`)
      await expect(preview).toBeVisible({ timeout: 30_000 })
      expect(await preview.evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBe(
        2
      )
      expect(await preview.getAttribute('src')).toBe(`data:image/png;base64,${IMAGE_BASE64}`)
      await expect(orcaPage.getByText('Unable to load file', { exact: true })).toHaveCount(0)

      const state = await orcaPage.evaluate((filePath) => {
        const file = window.__store?.getState().openFiles.find((item) => item.filePath === filePath)
        return file
          ? {
              externalSshTargetId: file.externalSshTargetId,
              relativePath: file.relativePath
            }
          : null
      }, REMOTE_IMAGE_PATH)
      expect(state).toEqual({
        externalSshTargetId: remote.targetId,
        relativePath: REMOTE_IMAGE_PATH
      })

      const remoteHash = execDockerSshRelayTargetCommand(
        target,
        `sha256sum ${shellQuote(REMOTE_IMAGE_PATH)} | cut -d' ' -f1`
      )
      expect(remoteHash).toBe(
        createHash('sha256').update(Buffer.from(IMAGE_BASE64, 'base64')).digest('hex')
      )
      await testInfo.attach('ssh-external-image-preview', {
        body: await orcaPage.screenshot(),
        contentType: 'image/png'
      })
    } finally {
      if (!cleanupDeferred) {
        cleanupDockerSshRelayTarget(target)
      }
    }
  })
})
