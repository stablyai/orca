import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { TEST_REPO_PATH_FILE } from './global-setup'
import { test, expect } from './helpers/orca-app'
import { createRestartSession } from './helpers/orca-restart'
import {
  mutateStoppedProfileState,
  readPersistedProfileState
} from './helpers/persisted-profile-state'
import { SIDEBAR_INPUTS_BUILD } from './helpers/sidebar-shadow'
import { waitForSessionReady } from './helpers/store'
import { postClaudeHook, readHookEndpoint } from './helpers/agent-hook-endpoint'
import { WorkspaceRowsSnapshotSchema } from '../../src/shared/sidebar-list/workspace-rows'

test.skip(
  !SIDEBAR_INPUTS_BUILD,
  'the host stamps sort keys only in an ORCA_SIDEBAR_INPUTS=main build'
)

function storedTiers(userDataDir: string, ids: readonly string[]): Record<string, unknown> {
  const meta = readPersistedProfileState(userDataDir).worktreeMeta
  const rows = meta && typeof meta === 'object' ? Object.entries(meta) : []
  return Object.fromEntries(
    rows
      .filter(([id]) => ids.includes(id))
      .map(([id, row]) => [
        id,
        row && typeof row === 'object' && 'smartTier' in row ? row.smartTier : undefined
      ])
  )
}

async function readMainTier(page: Page, worktreeId: string): Promise<string | undefined> {
  const response = await page.evaluate(() =>
    window.api.runtime.call({ method: 'sidebarInputs.workspaceRows' })
  )
  if (!response.ok) {
    throw new Error('sidebarInputs.workspaceRows failed')
  }
  return WorkspaceRowsSnapshotSchema.parse(response.result).rows[`local|${worktreeId}`]?.smartTier
}

test('a restart clears a tier nothing backs, keeps a hook row’s and an SSH host’s', async (// oxlint-disable-next-line no-empty-pattern -- This exercise owns its app launch.
{}, testInfo) => {
  test.setTimeout(3 * 60_000)
  test.skip(!existsSync(TEST_REPO_PATH_FILE), 'Global setup did not produce a seeded test repo')
  const session = createRestartSession(testInfo)
  let folderToRemove: string | null = null
  let app: ElectronApplication | null = null
  try {
    const first = await session.launch()
    await waitForSessionReady(first.page)
    const repoPath = readFileSync(TEST_REPO_PATH_FILE, 'utf8').trim()
    const repoId = await first.page.evaluate(async (path) => {
      const result = await window.api.repos.add({ path })
      if ('error' in result) {
        throw new Error(result.error)
      }
      return result.repo.id
    }, repoPath)
    const hookId = `${repoId}::${repoPath}`
    const folderPath = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orca-sort-stamps-')))
    const goneFolderId = await first.page.evaluate(async (parentPath) => {
      const store = window.__store!
      const group = await window.api.projectGroups.create({
        name: 'Stamps folder project',
        parentPath,
        createdFrom: 'folder-scan'
      })
      await store.getState().fetchProjectGroups({ runtimeEnvironmentId: null, throwOnError: true })
      const folder = await store
        .getState()
        .createFolderWorkspace(
          { projectGroupId: group.id, name: 'Stamps folder', folderPath: parentPath },
          { runtimeEnvironmentId: null }
        )
      if (!folder) {
        throw new Error('Expected a folder workspace')
      }
      return folder.id
    }, folderPath)
    folderToRemove = folderPath
    const goneId = `folder:${goneFolderId}`
    const sshId = `${repoId}::/srv/stamps-remote`
    const ids = [hookId, sshId]

    // A finished turn whose row the hook server saves; no terminal is ever opened.
    const endpoint = await readHookEndpoint(first.app)
    const pane = { paneKey: 'tab-stamps:11111111-1111-4111-8111-111111111111', worktreeId: hookId }
    await postClaudeHook(endpoint, pane, { hook_event_name: 'UserPromptSubmit', prompt: 'go' })
    await postClaudeHook(endpoint, pane, { hook_event_name: 'Stop', last_assistant_message: 'ok' })
    await expect.poll(() => readMainTier(first.page, hookId)).toBe('done')
    await session.close(first.app)

    mutateStoppedProfileState(session.userDataDir, (state) => {
      const existing =
        state.worktreeMeta && typeof state.worktreeMeta === 'object' ? state.worktreeMeta : {}
      // Recent, so the metadata collector keeps the SSH entry, whose path is not on this machine.
      const row = {
        displayName: 'stamps',
        lastActivityAt: Date.now(),
        smartTier: 'working',
        smartAt: 4
      }
      state.folderWorkspaces = Array.isArray(state.folderWorkspaces)
        ? state.folderWorkspaces.map((folder) =>
            folder && typeof folder === 'object' && 'id' in folder && folder.id === goneFolderId
              ? { ...folder, smartTier: 'working', smartAt: 4 }
              : folder
          )
        : state.folderWorkspaces
      // The folder workspace's terminal died while Orca was closed: its id is on record, its
      // session is gone from the daemon.
      const session =
        state.workspaceSession && typeof state.workspaceSession === 'object'
          ? state.workspaceSession
          : {}
      const tabsByWorktree =
        'tabsByWorktree' in session &&
        session.tabsByWorktree &&
        typeof session.tabsByWorktree === 'object'
          ? session.tabsByWorktree
          : {}
      state.workspaceSession = {
        ...session,
        tabsByWorktree: {
          ...tabsByWorktree,
          [goneId]: [
            {
              id: 'tab-stamps-gone',
              ptyId: 'stamps-dead-pty',
              worktreeId: goneId,
              title: 'Terminal 1',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: Date.now()
            }
          ]
        }
      }
      state.worktreeMeta = {
        ...existing,
        [sshId]: { ...row, instanceId: 'stamps-remote', hostId: 'ssh:unreachable' }
      }
    })
    expect(storedTiers(session.userDataDir, ids)).toEqual({
      [hookId]: 'done',
      [sshId]: 'working'
    })

    const second = await session.launch()
    app = second.app
    await waitForSessionReady(second.page)
    // The reconcile runs once hook rows and PTYs settle.
    await expect.poll(() => readMainTier(second.page, goneId), { timeout: 30_000 }).toBeUndefined()
    expect(await readMainTier(second.page, hookId)).toBe('done')
    await session.close(app)
    app = null
    // The unreached SSH host is not evidence its agents died.
    expect(storedTiers(session.userDataDir, ids)).toEqual({
      [hookId]: 'done',
      [sshId]: 'working'
    })
  } finally {
    await session.dispose(app ?? undefined)
    if (folderToRemove) {
      rmSync(folderToRemove, { recursive: true, force: true })
    }
  }
})
