/** Pairing, folder-workspace and liveness-control setup shared by the paired editor mirror specs. */
import { mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Page, TestInfo } from '@stablyai/playwright-test'
import {
  activateHostWorktreeOnClient,
  isMirrorOf,
  openLocalFile,
  readOpenFileRows
} from './editor-mirror-renderer-store'
import { log } from './editor-mirror-soak'
import { expect } from './orca-app'
import { waitForPairedClientWorktree } from './paired-client-host-session'
import {
  createRuntimeDesktopPairingOffer,
  launchPairedElectronClient,
  type PairedElectronClient,
  type RuntimeDesktopPairingOffer
} from './paired-electron-client'

export const INDEX_SUFFIX = 'src/index.ts'
export const README_SUFFIX = 'README.md'
export const CLAUDE_SUFFIX = 'CLAUDE.md'

type FolderWorkspaceHandle = {
  repoId: string
  worktreeId: string
  terminalTabCount: number
}

export function makeScratchDir(prefix: string, files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix))
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(path.join(dir, name), content)
  }
  return dir
}

/** Pairs `hubPage`'s app to another host and makes it the active environment. Inlines the body of
 *  addPairedRuntimeEnvironment (nested-runtime-ssh-client-route.ts) so it works on any Page. */
export async function pairBack(
  hubPage: Page,
  offer: RuntimeDesktopPairingOffer,
  name: string
): Promise<string> {
  return hubPage.evaluate(
    async ({ name, pairingUrl }) => {
      const store = window.__store
      if (!store) {
        throw new Error('Hub store is unavailable')
      }
      const result = await window.api.runtimeEnvironments.addFromPairingCode({
        name,
        pairingCode: pairingUrl
      })
      store.getState().setRuntimeEnvironments(await window.api.runtimeEnvironments.list())
      if (!(await store.getState().refreshRuntimeEnvironmentStatus(result.environment.id))) {
        throw new Error(`Hub could not reach ${name}`)
      }
      if (!(await store.getState().setActiveRuntimeEnvironmentPreference(result.environment.id))) {
        throw new Error(`Hub could not select ${name}`)
      }
      return result.environment.id
    },
    { name, pairingUrl: offer.pairingUrl }
  )
}

/** Adds a folder workspace and returns its catalog worktree key read from `worktreesByRepo`
 *  (the folder key is `folder:<folderWorkspaceId>`, which is not the repo id). */
export async function addFolderWorkspace(
  page: Page,
  folderPath: string
): Promise<FolderWorkspaceHandle> {
  return page.evaluate(async (folderPath) => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is unavailable')
    }
    const repo = await store.getState().addNonGitFolder(folderPath)
    if (!repo) {
      throw new Error(`addNonGitFolder returned null for ${folderPath}`)
    }
    const worktree = store.getState().worktreesByRepo[repo.id]?.[0]
    if (!worktree) {
      throw new Error(`No worktree row for folder repo ${repo.id}`)
    }
    return {
      repoId: repo.id,
      worktreeId: worktree.id,
      terminalTabCount: (store.getState().tabsByWorktree[worktree.id] ?? []).length
    }
  }, folderPath)
}

export async function knowsFolderWorkspace(page: Page, folderKey: string): Promise<boolean> {
  return page.evaluate(
    (folderKey) =>
      (window.__store?.getState().folderWorkspaces ?? []).some(
        (workspace) => `folder:${workspace.id}` === folderKey
      ),
    folderKey
  )
}

export async function pairClientToHost(
  hubPage: Page,
  testInfo: TestInfo,
  name: string,
  hostWorktreeId: string
): Promise<PairedElectronClient> {
  const offer = await createRuntimeDesktopPairingOffer(hubPage)
  const client = await launchPairedElectronClient(offer, testInfo, name)
  try {
    await waitForPairedClientWorktree(client.page, hostWorktreeId)
    await activateHostWorktreeOnClient(client, hostWorktreeId)
    return client
  } catch (error) {
    await client.dispose()
    throw error
  }
}

/** Positive control: a file opened on `source` in its own folder workspace must land on `sink`
 *  as a marked mirror under `sourceEnvOnSink`. Proves the sink's subscribeAll to that peer is live. */
export async function proveMirrorLands(
  label: string,
  source: Page,
  sink: Page,
  sourceEnvOnSink: string,
  scratchDirs: string[]
): Promise<FolderWorkspaceHandle & { controlPath: string }> {
  const folder = makeScratchDir(`orca-mirror-echo-${label}-`, {
    'control.md': `# ${label} liveness control\n`
  })
  scratchDirs.push(folder)
  const handle = await addFolderWorkspace(source, folder)
  log(
    `${label}: folder workspace ${handle.worktreeId} (repo ${handle.repoId}); ${handle.terminalTabCount} terminal tab(s) auto-created (accepted, not under test)`
  )
  const controlPath = path.join(folder, 'control.md')
  await openLocalFile(source, {
    filePath: controlPath,
    relativePath: 'control.md',
    worktreeId: handle.worktreeId,
    language: 'markdown'
  })
  await expect
    .poll(
      async () =>
        (await readOpenFileRows(sink, 'control.md')).some((row) =>
          isMirrorOf(row, handle.worktreeId, sourceEnvOnSink)
        ),
      {
        timeout: 60_000,
        message: `LIVENESS CONTROL "${label}": sink never mirrored ${controlPath} under ${sourceEnvOnSink} — the sink's subscription to that peer is not live, so any no-echo result would be vacuous`
      }
    )
    .toBe(true)
  return { ...handle, controlPath }
}
