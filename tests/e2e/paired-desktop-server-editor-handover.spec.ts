// H5d: with ORCA_LAYOUT_OWNER=main, hand a mirror-created editor tab to server authority before its layout frames draw.
// Keep the desktop’s tab id, file and unsaved draft in the server layout.
import { existsSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  HOST_TERMINAL_SURFACE_SEPARATOR,
  toWebTerminalSurfaceTabId
} from '../../src/shared/terminal-surface-id'
import { LAYOUT_INTENTS_RUNTIME_CAPABILITY } from '../../src/shared/workspace-layout/layout-intents-capability'
import { expect, test } from './helpers/orca-app'
import { launchHeadlessPairedRuntimeHost } from './helpers/headless-paired-runtime-host'
import {
  launchPairedElectronClient,
  type PairedElectronClient
} from './helpers/paired-electron-client'
import {
  expectFrameDrawnTreeMatchesServer,
  readServerLayout
} from './helpers/paired-desktop-server-layout'
import { waitForWorktree } from './helpers/paired-desktop-server-terminal-tab'

const LAYOUT_OWNER_BUILD = existsSync(
  path.join(process.cwd(), 'out', 'main', 'ORCA_LAYOUT_OWNER_MAIN')
)
const FILE_NAME = 'handover-note.md'
const DRAFT = 'unsaved desktop draft'

// Temporarily hide layout-intent support so the desktop opens its own mirror editor, then restore the capability.
async function openWhileMirrorDrawn(
  client: PairedElectronClient,
  worktreeId: string,
  filePath: string
): Promise<{ drawnWhileOpening: boolean | null; fileId: string; tabId: string | null }> {
  return client.page.evaluate(
    ({ environmentId, worktreeId, filePath, fileName, draft, capability }) => {
      const store = window.__store!
      const statuses = store.getState().runtimeStatusByEnvironmentId
      const entry = statuses.get(environmentId)!
      const withoutIntents = <S extends { capabilities?: string[] } | null | undefined>(
        status: S
      ): S =>
        status
          ? {
              ...status,
              capabilities: (status.capabilities ?? []).filter((name) => name !== capability)
            }
          : status
      store.setState({
        runtimeStatusByEnvironmentId: new Map(statuses).set(environmentId, {
          ...entry,
          status: withoutIntents(entry.status),
          ...(entry.snapshot
            ? { snapshot: { ...entry.snapshot, status: withoutIntents(entry.snapshot.status) } }
            : {})
        })
      })
      const drawnWhileOpening =
        window.__isFrameDrawnServerWorkspaceE2E?.(environmentId, worktreeId) ?? null
      const state = store.getState()
      const fileId = state.openFile({
        filePath,
        relativePath: fileName,
        worktreeId,
        runtimeEnvironmentId: environmentId,
        language: 'markdown',
        mode: 'edit'
      })
      const tab = (store.getState().unifiedTabsByWorktree[worktreeId] ?? []).find(
        (candidate) => candidate.entityId === fileId
      )
      store.getState().setEditorDraft(fileId, draft)
      store.getState().markFileDirty(fileId, true)
      // The server's capability back: a new stream hands the tab over, then gates the workspace.
      store.setState({
        runtimeStatusByEnvironmentId: new Map(store.getState().runtimeStatusByEnvironmentId).set(
          environmentId,
          entry
        )
      })
      return { drawnWhileOpening, fileId, tabId: tab?.id ?? null }
    },
    {
      environmentId: client.environmentId,
      worktreeId,
      filePath,
      fileName: FILE_NAME,
      draft: DRAFT,
      capability: LAYOUT_INTENTS_RUNTIME_CAPABILITY
    }
  )
}

test.describe('paired desktop hands its editor tabs to a switch-on server', () => {
  test.skip(!LAYOUT_OWNER_BUILD, 'Needs a layout-owner build (ORCA_LAYOUT_OWNER=main)')

  test('a tab opened while mirror-drawn survives the server’s frames and is the server’s', async ({
    testRepoPath
  }, testInfo) => {
    test.setTimeout(300_000)
    const filePath = path.join(testRepoPath, FILE_NAME)
    writeFileSync(filePath, '# on disk\n')
    const host = await launchHeadlessPairedRuntimeHost()
    let client: PairedElectronClient | null = null
    try {
      const status = await host.client.call<{ capabilities?: string[] }>('status.get')
      expect(status.result.capabilities ?? []).toContain(LAYOUT_INTENTS_RUNTIME_CAPABILITY)
      const added = await host.client.call<{ repo: { id: string } }>('repo.add', {
        path: testRepoPath,
        kind: 'folder'
      })
      const worktreeId = await waitForWorktree(host, added.result.repo.id)
      const created = await host.client.call<{ tab: { id: string } }>(
        'session.tabs.createTerminal',
        { worktree: `id:${worktreeId}`, activate: false, select: false, navigation: 'caller' }
      )
      const terminalTab = toWebTerminalSurfaceTabId(
        created.result.tab.id.split(HOST_TERMINAL_SURFACE_SEPARATOR)[0]!
      )

      client = await launchPairedElectronClient(host.offer, testInfo, 'server-editor-handover')
      const desktop = client
      await expect
        .poll(
          () =>
            desktop.page.evaluate(
              (id) =>
                window.__store
                  ?.getState()
                  .allWorktrees()
                  .some((worktree) => worktree.id === id) ?? false,
              worktreeId
            ),
          { timeout: 60_000, message: 'Paired desktop never listed the server workspace' }
        )
        .toBe(true)
      await desktop.page.evaluate(
        ({ environmentId, worktreeId, terminalTab }) => {
          const state = window.__store!.getState()
          state.setActiveView('terminal')
          state.setActiveWorktree(worktreeId, `runtime:${environmentId}`)
          state.setActiveTab(terminalTab)
        },
        { environmentId: desktop.environmentId, worktreeId, terminalTab }
      )
      await expectFrameDrawnTreeMatchesServer(
        host,
        desktop,
        worktreeId,
        'Desktop never drew the server workspace from frames'
      )

      const opened = await openWhileMirrorDrawn(desktop, worktreeId, filePath)
      expect(opened.drawnWhileOpening).toBe(false)
      expect(opened.tabId).not.toBeNull()

      const tree = await expectFrameDrawnTreeMatchesServer(
        host,
        desktop,
        worktreeId,
        'The desktop’s editor tab never reached the server’s layout'
      )
      expect(tree.flatMap((group) => group.tabs.map((tab) => tab.id))).toContain(opened.tabId)
      const serverTab = (await readServerLayout(host, worktreeId))?.tabs.find(
        (tab) => tab.id === opened.tabId
      )
      expect(serverTab?.kind).toBe('editor')
      expect(decodeURIComponent(serverTab?.entityId ?? '')).toContain(FILE_NAME)

      const kept = await desktop.page.evaluate(
        ({ worktreeId, fileId }) => {
          const state = window.__store!.getState()
          return {
            files: state.openFiles
              .filter((file) => file.worktreeId === worktreeId && file.id === fileId)
              .map((file) => file.runtimeEnvironmentId ?? null),
            draft: state.editorDrafts[fileId] ?? null
          }
        },
        { worktreeId, fileId: opened.fileId }
      )
      expect(kept).toEqual({ files: [desktop.environmentId], draft: DRAFT })
    } finally {
      await client?.dispose()
      await host.dispose()
    }
  })
})
