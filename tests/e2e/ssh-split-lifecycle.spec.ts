import type { Page, TestInfo } from '@stablyai/playwright-test'

// Supplemental transport/UI coverage; the rejected-cleanup red/green oracle lives in pty.test.ts.

import { expect, test } from './helpers/orca-app'
import {
  cleanupDockerSshRelayTarget,
  execDockerSshRelayTargetCommand,
  startDockerSshRelayTarget,
  type DockerSshRelayTarget
} from './helpers/docker-ssh-relay-target'
import { connectDockerSshRelayTarget } from './helpers/docker-ssh-relay-connection'
import {
  createRuntimeDesktopPairingOffer,
  launchPairedElectronClient,
  type PairedElectronClient
} from './helpers/paired-electron-client'
import {
  assertInteractiveTerminal,
  assertPairedTerminalCreation
} from './helpers/nested-runtime-ssh-client-route'
import { countVisibleTerminalPanes } from './helpers/terminal'

const RUN_DOCKER_SSH = process.env.ORCA_E2E_SSH_DOCKER === '1'

function readRemoteTtyShellPids(target: DockerSshRelayTarget): string[] {
  const output = execDockerSshRelayTargetCommand(
    target,
    'ps -eo pid=,tty=,comm= | awk \'$2 != "?" && $3 ~ /^(bash|sh|zsh)$/ { print $1 }\''
  )
  return output ? output.split(/\s+/).sort((a, b) => Number(a) - Number(b)) : []
}

function remoteTerminalHandle(ptyId: string): string {
  const separator = ptyId.indexOf('@@')
  if (!ptyId.startsWith('remote:') || separator === -1) {
    throw new Error(`Expected a runtime-owned PTY id, received ${ptyId}`)
  }
  return decodeURIComponent(ptyId.slice(separator + 2))
}

async function visiblePanePtyIds(page: Page): Promise<string[]> {
  return page.locator('[data-pty-id]').evaluateAll((elements) =>
    elements.flatMap((element) => {
      const rect = element.getBoundingClientRect()
      const style = window.getComputedStyle(element)
      const ptyId = (element as HTMLElement).dataset.ptyId
      return ptyId && rect.width > 0 && style.display !== 'none' && style.visibility !== 'hidden'
        ? [ptyId]
        : []
    })
  )
}

function terminalMarkerCommand(marker: string): string {
  const encoded = [...marker]
    .map((character) => `\\${character.charCodeAt(0).toString(8).padStart(3, '0')}`)
    .join('')
  return `printf '${encoded}\\n'`
}

async function activateHostLocalWorkspace(page: Page, remoteWorktreeId: string): Promise<void> {
  const localWorktreeId = await page.evaluate((remoteWorktreeId) => {
    const store = window.__store
    if (!store) {
      throw new Error('Host store is unavailable')
    }
    const state = store.getState()
    const localRepoIds = new Set(
      state.repos.filter((repo) => !repo.connectionId).map((repo) => repo.id)
    )
    const localWorktree = Object.entries(state.worktreesByRepo)
      .filter(([repoId]) => localRepoIds.has(repoId))
      .flatMap(([, worktrees]) => worktrees)
      .find((worktree) => worktree.id !== remoteWorktreeId)
    if (!localWorktree) {
      throw new Error('Host has no isolated local workspace for the paired topology')
    }
    state.setActiveWorktree(localWorktree.id)
    return localWorktree.id
  }, remoteWorktreeId)
  await expect
    .poll(() =>
      page
        .locator('[data-rendered-active-worktree-id]')
        .getAttribute('data-rendered-active-worktree-id')
    )
    .toBe(localWorktreeId)
}

async function replaceWithRuntimeOwnedSource(
  client: PairedElectronClient,
  worktreeId: string
): Promise<string> {
  return client.page.evaluate(
    async ({ environmentId, worktreeId }) => {
      const selector = `id:${worktreeId}`
      const listed = await window.api.runtimeEnvironments.call({
        selector: environmentId,
        method: 'terminal.list',
        params: { worktree: selector }
      })
      if (!listed.ok) {
        throw new Error(`Could not list the SSH source terminals: ${JSON.stringify(listed)}`)
      }
      const terminals = (listed.result as { terminals?: { handle: string }[] }).terminals ?? []
      for (const terminal of terminals) {
        const closed = await window.api.runtimeEnvironments.call({
          selector: environmentId,
          method: 'terminal.closeTab',
          params: { terminal: terminal.handle }
        })
        if (!closed.ok) {
          throw new Error(`Could not close the initial SSH source: ${JSON.stringify(closed)}`)
        }
      }
      const created = await window.api.runtimeEnvironments.call({
        selector: environmentId,
        method: 'terminal.create',
        params: { worktree: selector, title: 'STA-4023 SSH split source' }
      })
      if (!created.ok) {
        throw new Error(`Could not create the SSH split source: ${JSON.stringify(created)}`)
      }
      return (created.result as { terminal: { handle: string } }).terminal.handle
    },
    { environmentId: client.environmentId, worktreeId }
  )
}

async function readRenderedPane(client: PairedElectronClient, ptyId: string): Promise<string> {
  return client.page.evaluate((ptyId) => {
    for (const manager of window.__paneManagers?.values() ?? []) {
      const pane = manager
        .getPanes?.()
        .find((candidate) => candidate.container.dataset.ptyId === ptyId)
      if (pane) {
        return pane.serializeAddon?.serialize?.() ?? ''
      }
    }
    return ''
  }, ptyId)
}

async function sendRenderedMarker(
  client: PairedElectronClient,
  ptyId: string,
  marker: string
): Promise<void> {
  const terminal = client.page.locator(`[data-pty-id=${JSON.stringify(ptyId)}]`)
  await terminal.locator('.xterm-helper-textarea').focus()
  await client.page.keyboard.insertText(terminalMarkerCommand(marker))
  await client.page.keyboard.press('Enter')
  await expect.poll(() => readRenderedPane(client, ptyId), { timeout: 30_000 }).toContain(marker)
}

async function runPairedSshSplitLifecycle(
  client: PairedElectronClient,
  target: DockerSshRelayTarget,
  repoId: string,
  worktreeId: string
): Promise<void> {
  const sourceHandle = await replaceWithRuntimeOwnedSource(client, worktreeId)
  const source = await assertInteractiveTerminal(client, repoId, `STA4023_SOURCE_${Date.now()}`)
  expect(remoteTerminalHandle(source.ptyId)).toBe(sourceHandle)

  const panesBefore = await countVisibleTerminalPanes(client.page)
  const shellPidsBefore = readRemoteTtyShellPids(target)
  expect(shellPidsBefore).toHaveLength(1)
  expect(await visiblePanePtyIds(client.page)).toContain(source.ptyId)

  const response = await client.page.evaluate(
    ({ environmentId, terminal }) =>
      window.api.runtimeEnvironments.call({
        selector: environmentId,
        method: 'terminal.split',
        params: { terminal, direction: 'vertical' }
      }),
    { environmentId: client.environmentId, terminal: sourceHandle }
  )
  expect(response.ok).toBe(true)
  const splitHandle = (response.result as { split: { handle: string } }).split.handle
  expect(splitHandle).not.toBe(sourceHandle)

  await expect.poll(() => countVisibleTerminalPanes(client!.page)).toBe(panesBefore + 1)
  let splitPtyId = ''
  await expect
    .poll(async () => {
      const ptyIds = await visiblePanePtyIds(client.page)
      splitPtyId =
        ptyIds.find((ptyId) => {
          try {
            return remoteTerminalHandle(ptyId) === splitHandle
          } catch {
            return false
          }
        }) ?? ''
      return { source: ptyIds.includes(source.ptyId), split: splitPtyId !== '' }
    })
    .toEqual({ source: true, split: true })
  let splitShellPid = ''
  await expect
    .poll(() => {
      const shellPids = readRemoteTtyShellPids(target!)
      splitShellPid = shellPids.find((pid) => !shellPidsBefore.includes(pid)) ?? ''
      return shellPids.length
    })
    .toBe(2)
  expect(splitPtyId).not.toBe(source.ptyId)
  expect(splitShellPid).not.toBe('')

  const splitMarker = `STA4023_SPLIT_${Date.now()}`
  await sendRenderedMarker(client, splitPtyId, splitMarker)

  const closed = await client.page.evaluate(
    ({ environmentId, terminal }) =>
      window.api.runtimeEnvironments.call({
        selector: environmentId,
        method: 'terminal.close',
        params: { terminal }
      }),
    { environmentId: client.environmentId, terminal: splitHandle }
  )
  expect(closed.ok).toBe(true)
  await expect.poll(() => readRemoteTtyShellPids(target)).not.toContain(splitShellPid)
  await expect.poll(() => countVisibleTerminalPanes(client!.page)).toBe(panesBefore)
  await expect.poll(() => visiblePanePtyIds(client.page)).not.toContain(splitPtyId)
  expect(readRemoteTtyShellPids(target)).toContain(shellPidsBefore[0])

  await sendRenderedMarker(client, source.ptyId, `STA4023_SOURCE_SURVIVES_${Date.now()}`)
  await assertPairedTerminalCreation(client, `STA4023_FRESH_TERMINAL_${Date.now()}`)
  expect(await client.getDirectSshAttemptTargetIds()).toEqual([])
}

async function runHeadedSshSplitLifecycle(hubPage: Page, testInfo: TestInfo): Promise<void> {
  test.setTimeout(360_000)
  let target: DockerSshRelayTarget | null = null
  let client: PairedElectronClient | null = null
  try {
    target = startDockerSshRelayTarget(testInfo)
    const remote = await connectDockerSshRelayTarget(hubPage, target)
    await activateHostLocalWorkspace(hubPage, remote.worktreeId)
    const offer = await createRuntimeDesktopPairingOffer(hubPage)
    client = await launchPairedElectronClient(offer, testInfo, 'STA-4023 SSH split lifecycle')
    await runPairedSshSplitLifecycle(client, target, remote.repoId, remote.worktreeId)
  } finally {
    try {
      await client?.dispose()
    } finally {
      cleanupDockerSshRelayTarget(target)
    }
  }
}

test.describe('paired SSH split lifecycle', () => {
  test.skip(!RUN_DOCKER_SSH, 'Set ORCA_E2E_SSH_DOCKER=1 to run the Docker SSH oracle.')
  test.skip(process.platform === 'win32', 'The disposable SSH target uses POSIX tooling.')

  test('headed runtime owns both SSH split panes and closes only the selected pane @headful', async ({
    orcaPage
  }, testInfo) => runHeadedSshSplitLifecycle(orcaPage, testInfo))

  test('hidden desktop host preserves SSH split and close parity', async ({ orcaPage }, testInfo) =>
    runHeadedSshSplitLifecycle(orcaPage, testInfo))
})
