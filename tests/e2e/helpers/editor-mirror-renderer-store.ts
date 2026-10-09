/** Renderer-store reads and editor actions for the paired editor mirror specs. */
import type { Locator, Page } from '@stablyai/playwright-test'
import type { PairedElectronClient } from './paired-electron-client'

export type OpenFileRow = {
  id: string
  filePath: string
  worktreeId: string
  runtimeEnvironmentId: string | null
  hasRuntimeEnvironmentId: boolean
  mirroredFromRuntimeSession: boolean | undefined
  externalSshTargetId: string | undefined
}

type UnifiedEditorTab = {
  id: string
  entityId: string
  label: string
  executionHostId: string | undefined
}

type TerminalLayout = {
  terminalIds: string[]
  groups: { id: string; terminalOrder: string[] }[]
}

export async function readOpenFileRows(page: Page, suffix: string): Promise<OpenFileRow[]> {
  return page.evaluate((suffix) => {
    const state = window.__store?.getState()
    if (!state) {
      throw new Error('window.__store is unavailable')
    }
    return state.openFiles
      .filter((file) => file.filePath.endsWith(suffix))
      .map((file) => ({
        id: file.id,
        filePath: file.filePath,
        worktreeId: file.worktreeId,
        runtimeEnvironmentId: file.runtimeEnvironmentId ?? null,
        hasRuntimeEnvironmentId: file.runtimeEnvironmentId !== undefined,
        mirroredFromRuntimeSession: file.mirroredFromRuntimeSession,
        externalSshTargetId: file.externalSshTargetId
      }))
  }, suffix)
}

export async function readUnifiedEditorTabs(
  page: Page,
  worktreeId: string
): Promise<UnifiedEditorTab[]> {
  return page.evaluate((worktreeId) => {
    const state = window.__store?.getState()
    if (!state) {
      throw new Error('window.__store is unavailable')
    }
    return (state.unifiedTabsByWorktree[worktreeId] ?? [])
      .filter((tab) => tab.contentType === 'editor')
      .map((tab) => ({
        id: tab.id,
        entityId: tab.entityId,
        label: tab.label,
        executionHostId: tab.executionHostId
      }))
  }, worktreeId)
}

/** Terminal tab ids and each group's terminal-only order: what an empty peer frame must not touch. */
export async function readTerminalLayout(page: Page, worktreeId: string): Promise<TerminalLayout> {
  return page.evaluate((worktreeId) => {
    const state = window.__store?.getState()
    if (!state) {
      throw new Error('window.__store is unavailable')
    }
    const unified = state.unifiedTabsByWorktree[worktreeId] ?? []
    const terminalUnifiedIds = new Set(
      unified.filter((tab) => tab.contentType === 'terminal').map((tab) => tab.id)
    )
    return {
      terminalIds: (state.tabsByWorktree[worktreeId] ?? []).map((tab) => tab.id).sort(),
      groups: (state.groupsByWorktree[worktreeId] ?? []).map((group) => ({
        id: group.id,
        terminalOrder: group.tabOrder.filter((id) => terminalUnifiedIds.has(id))
      }))
    }
  }, worktreeId)
}

/** Editor tabs render `data-tab-id` with the file label as text (tab-bar/EditorFileTab.tsx); the
 *  dnd-kit attributes give the root role="button", so getByRole('tab') cannot match it. */
export function editorTabLocator(page: Page, label: string): Locator {
  return page.locator('[data-tab-id]').filter({ hasText: label })
}

export async function readAllWorktreeIds(page: Page): Promise<string[]> {
  return page.evaluate(
    () =>
      window.__store
        ?.getState()
        .allWorktrees()
        .map((w) => w.id) ?? []
  )
}

export async function readActiveWorktreeId(page: Page): Promise<string | null> {
  return page.evaluate(() => window.__store?.getState().activeWorktreeId ?? null)
}

export async function readActiveRuntimeEnvironmentId(page: Page): Promise<string | null> {
  return page.evaluate(
    () => window.__store?.getState().settings?.activeRuntimeEnvironmentId ?? null
  )
}

/** Opens a file the way a local explorer click would. The explicit `null` defeats the
 *  active-environment fallback, so the row keeps a bare-path id and local ownership. */
export async function openLocalFile(
  page: Page,
  file: { filePath: string; relativePath: string; worktreeId: string; language: string }
): Promise<void> {
  await page.evaluate((file) => {
    window.__store?.getState().openFile(
      {
        filePath: file.filePath,
        relativePath: file.relativePath,
        worktreeId: file.worktreeId,
        language: file.language,
        runtimeEnvironmentId: null,
        mode: 'edit'
      },
      { preview: false }
    )
  }, file)
}

export async function closeFileById(page: Page, fileId: string): Promise<void> {
  await page.evaluate((fileId) => {
    window.__store?.getState().closeFile(fileId)
  }, fileId)
}

/** Makes the host's worktree active on a paired client under that host's runtime owner. */
export async function activateHostWorktreeOnClient(
  client: PairedElectronClient,
  worktreeId: string
): Promise<void> {
  await client.page.evaluate(
    ({ environmentId, worktreeId }) => {
      window.__store?.getState().setActiveWorktree(worktreeId, `runtime:${environmentId}`)
    },
    { environmentId: client.environmentId, worktreeId }
  )
}

export function isMirrorOf(row: OpenFileRow, worktreeId: string, environmentId: string): boolean {
  return (
    row.worktreeId === worktreeId &&
    row.runtimeEnvironmentId === environmentId &&
    row.mirroredFromRuntimeSession === true
  )
}
