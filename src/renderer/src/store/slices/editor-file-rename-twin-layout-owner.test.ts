// @vitest-environment happy-dom

// A disk rename of a file open in a workspace main lays out and in a twin, which main may route to
// a paired server (host_not_owned), in a layout-owner build: the twin's refusal reaches only the
// twin, whichever workspace the move lists first.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { isTwinWorkspace } from '@/lib/resolve-owner'
import { buildOwnedEditorFileId } from './editor/file-ids/editor-file-ids'
import type { AppState } from '@/store/types'
import type { LayoutCommand } from '../../../../shared/workspace-layout/workspace-layout-command-types'
import { layoutApplyTestTransport } from '@/runtime/layout-apply-test-transport.test-fixture'
import { contentRekeyOutcome } from '@/runtime/layout-owner-content-rekeys'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import { drawTabsFromMain, type TabsDrawnFromMain } from './tabs-drawn-from-main.test-fixture'

// Main's answer to the window's layout commands, as a switch-on build sends them.
vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)
vi.mock('@/runtime/runtime-layout-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeLayoutClientWithTestFrames(await importOriginal())
)

const WT = 'repo-a::/repo-a'
const TWIN = 'repo-a::/repo-a-twin'
const FILE = '/repo-a/src/a.ts'

let main: TabsDrawnFromMain

beforeEach(async () => {
  useAppStore.setState(useAppStore.getInitialState(), true)
  const twinRow = { id: TWIN, repoId: 'repo-a', path: '/repo-a-twin', hostId: 'local', branch: '' }
  useAppStore.setState(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a partial catalog with only the fields editor opens, owner routes and frames read.
    {
      activeWorktreeId: WT,
      settings: { editorAutoSave: false },
      repos: [{ id: 'repo-a', path: '/repo-a', kind: 'git', executionHostId: 'local' }],
      worktreesByRepo: {
        'repo-a': [
          { id: WT, repoId: 'repo-a', path: '/repo-a', hostId: 'local', branch: '' },
          // Published by this host and by a paired server: a twin.
          twinRow,
          { ...twinRow, runtimeOwnerEnvironmentId: 'runtime-1' }
        ]
      },
      detectedWorktreesByRepo: {},
      runtimeEnvironments: [],
      runtimeEnvironmentCatalogHydrated: true,
      removedRuntimeEnvironmentIds: new Set(),
      sshConnectionStates: new Map(),
      sshStateByEnvironment: new Map(),
      folderWorkspaces: [],
      projectGroups: [],
      gitStatusHugeByWorktree: {}
    } as unknown as Partial<AppState>
  )
  main = await drawTabsFromMain(useAppStore)
  // Main routes the twin to the paired server.
  layoutApplyTestTransport.answerWith((command) =>
    touches(command, TWIN) ? { ok: false, code: 'host_not_owned' } : 'apply'
  )
})

afterEach(() => main.close())

function touches(command: LayoutCommand, workspace: string): boolean {
  return (
    command.workspace === workspace ||
    (command.type === 'renameEditorFiles' &&
      (command.alsoIn ?? []).some((entry) => entry.workspace === workspace))
  )
}

function openEdit(worktreeId: string): string {
  return useAppStore.getState().openFile(
    {
      filePath: FILE,
      relativePath: 'src/a.ts',
      worktreeId,
      runtimeEnvironmentId: null,
      language: 'typescript',
      mode: 'edit'
    },
    { suppressActiveRuntimeFallback: true }
  )
}

const pathsIn = (worktreeId: string) =>
  useAppStore
    .getState()
    .openFiles.filter((file) => file.worktreeId === worktreeId)
    .map((file) => file.filePath)

describe.runIf(ORCA_LAYOUT_OWNER_IS_MAIN)('a disk rename beside a twin, layout-owner build', () => {
  it.each([
    ['the main-owned workspace first', [WT, TWIN]],
    ['the twin first', [TWIN, WT]]
  ])('renames each workspace once, %s in the move', async (_name, order) => {
    expect(isTwinWorkspace(useAppStore.getState(), TWIN)).toBe(true)
    openEdit(WT)
    openEdit(TWIN)
    await main.settle()
    expect(pathsIn(WT)).toEqual([FILE])
    expect(pathsIn(TWIN)).toEqual([FILE])
    const ids = useAppStore.getState().openFiles.map((file) => file.id)
    const sentBefore = layoutApplyTestTransport.sent.length

    const rekeyOf = (worktreeId: string) => {
      const file = useAppStore.getState().openFiles.find((entry) => entry.worktreeId === worktreeId)
      const newFilePath = '/repo-a/lib/a.ts'
      return {
        oldFileId: file?.id ?? '',
        newFileId:
          worktreeId === WT ? newFilePath : buildOwnedEditorFileId(newFilePath, TWIN, null),
        oldFilePath: FILE,
        newFilePath,
        newRelativePath: 'lib/a.ts'
      }
    }

    const result = useAppStore
      .getState()
      .rekeyOpenFilesForPathChange({ rekeys: order.map(rekeyOf) })

    expect(result).toEqual({ ok: true })
    expect(await contentRekeyOutcome(ids)).toBe(true)
    await main.settle()
    const renames = layoutApplyTestTransport.sent
      .slice(sentBefore)
      .filter((command) => command.type === 'renameEditorFiles')
    // The twin goes alone, so its refusal does not refuse the main-owned workspace's rename.
    expect(renames.filter((command) => touches(command, TWIN)).map((c) => c.workspace)).toEqual([
      TWIN
    ])
    expect(layoutApplyTestTransport.mainModel?.workspaces[WT]?.editorFiles).toEqual([
      expect.objectContaining({ filePath: '/repo-a/lib/a.ts' })
    ])
    expect(pathsIn(WT)).toEqual(['/repo-a/lib/a.ts'])
    expect(pathsIn(TWIN)).toEqual(['/repo-a/lib/a.ts'])
  })
})
