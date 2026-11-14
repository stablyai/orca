// A local file and a runtime-environment file at one path in one workspace are two records: each
// open, reload, move and close touches its own owner's record only.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../constants'
import '../../execution-host'
import { ownedEditorFileId } from '../../workspace-session/workspace-session-pane-ownership'
import type {
  PersistedOpenFile,
  WorkspaceSessionState
} from '../../workspace-session/workspace-session-state-types'
import { applyLayoutCommand } from '../workspace-layout-commands'
import type { CommandOf } from '../workspace-layout-command-types'
import { build, testContext } from '../commands/workspace-layout-command.test-fixture'
import './workspace-layout-editor-tab-file'
import '../persistence/workspace-layout-load'
import type { LayoutEditorFile, WorkspaceLayoutModel } from '../workspace-layout-model'
import '../published-layout/workspace-layout-published'
import { patchStoredSession } from '../persistence/workspace-layout-record-patch'
import '../persistence/workspace-layout-save'
import { emptySession, GIT_KEY } from '../persistence/workspace-layout-session.test-fixture'

const mocks = vi.hoisted(() => ({ layoutOwnerIsMain: true }))
vi.mock('../../layout-owner-switch', () => ({
  get ORCA_LAYOUT_OWNER_IS_MAIN() {
    return mocks.layoutOwnerIsMain
  }
}))

beforeEach(() => {
  mocks.layoutOwnerIsMain = true
})

const FLOATING = FLOATING_TERMINAL_WORKTREE_ID
const PATH = '/Users/dev/notes/todo.md'
const ENV = 'env-1'
const LOCAL_FILE: LayoutEditorFile = {
  filePath: PATH,
  relativePath: 'todo.md',
  language: 'markdown'
}
const RUNTIME_FILE: LayoutEditorFile = { ...LOCAL_FILE, runtimeEnvironmentId: ENV }

const localId = (key: string): string => ownedEditorFileId(PATH, key, null)
const runtimeId = (key: string): string => ownedEditorFileId(PATH, key, ENV)

const open = (key: string, fileId: string, file: LayoutEditorFile): CommandOf<'openEditorTab'> => ({
  type: 'openEditorTab',
  workspace: key,
  tabId: fileId,
  fileId,
  contentType: 'editor',
  file
})

/** Both owners' tabs open in `key`: the local one under `localTabId`, the runtime one owned. */
function bothOpen(key: string, localTabId: string) {
  const ctx = testContext()
  const built = build(ctx, [
    open(key, localTabId, LOCAL_FILE),
    open(key, runtimeId(key), RUNTIME_FILE)
  ])
  return { ctx, model: built.model }
}

const owners = (model: WorkspaceLayoutModel, key: string) =>
  (model.workspaces[key]?.editorFiles ?? []).map((file) => file.runtimeEnvironmentId ?? 'local')

function closeTab(model: WorkspaceLayoutModel, key: string, tabId: string): WorkspaceLayoutModel {
  const closed = applyLayoutCommand(
    model,
    { type: 'closeTabs', workspace: key, tabIds: [tabId] },
    testContext()
  )
  if (!closed.ok) {
    throw new Error(closed.code)
  }
  return closed.model
}

describe('editor file records keyed by path and owner, layout-owner build', () => {
  it("opening the second owner's file keeps the first owner's record", () => {
    const { model } = bothOpen(FLOATING, localId(FLOATING))

    expect(owners(model, FLOATING)).toEqual(['local', ENV])
  })

  it("reopening one owner's file replaces only that owner's record", () => {
    const { ctx, model } = bothOpen(FLOATING, localId(FLOATING))
    const renamed = { ...RUNTIME_FILE, relativePath: 'renamed.md' }

    const again = build(ctx, [open(FLOATING, runtimeId(FLOATING), renamed)], model)

    expect(again.model.workspaces[FLOATING]!.editorFiles).toEqual([LOCAL_FILE, renamed])
  })

  it("moving one owner's tab moves only that owner's record", () => {
    const ctx = testContext()
    const { model } = build(ctx, [
      open(GIT_KEY, PATH, LOCAL_FILE),
      open(GIT_KEY, runtimeId(GIT_KEY), RUNTIME_FILE),
      open(FLOATING, localId(FLOATING), LOCAL_FILE)
    ])
    const groupId = model.workspaces[FLOATING]!.groups[0]!.id

    const moved = build(
      ctx,
      [
        {
          type: 'moveTabToWorkspace',
          workspace: GIT_KEY,
          toWorkspace: FLOATING,
          tabs: [
            {
              tabId: runtimeId(GIT_KEY),
              newTabId: runtimeId(FLOATING),
              newEntityId: runtimeId(FLOATING)
            }
          ],
          groupId,
          file: RUNTIME_FILE
        }
      ],
      model
    )

    expect(owners(moved.model, GIT_KEY)).toEqual(['local'])
    expect(owners(moved.model, FLOATING)).toEqual(['local', ENV])
  })

  it.each([
    ['floating, both owned', FLOATING, localId(FLOATING)],
    ['a path-id local tab', GIT_KEY, PATH]
  ])('closing the local tab keeps the runtime record (%s)', (_name, key, localTabId) => {
    const { model } = bothOpen(key, localTabId)

    expect(owners(closeTab(model, key, localTabId), key)).toEqual([ENV])
  })

  it.each([
    ['floating, both owned', FLOATING, localId(FLOATING)],
    ['a path-id local tab', GIT_KEY, PATH]
  ])('closing the runtime tab keeps the local record (%s)', (_name, key, localTabId) => {
    const { model } = bothOpen(key, localTabId)

    expect(owners(closeTab(model, key, runtimeId(key)), key)).toEqual(['local'])
  })

  it("writing the second owner's open onto the stored session adds its record", () => {
    const local = { ...LOCAL_FILE, worktreeId: FLOATING }
    const runtime = { ...RUNTIME_FILE, worktreeId: FLOATING }
    const session = (files: PersistedOpenFile[]): WorkspaceSessionState => ({
      ...emptySession(),
      openFilesByWorktree: { [FLOATING]: files }
    })

    const patched = patchStoredSession(
      session([local]),
      session([local]),
      session([local, runtime])
    )

    expect(patched.openFilesByWorktree?.[FLOATING]).toEqual([local, runtime])
  })

  it('match by path alone when the switch is off, as a headless host does today', () => {
    mocks.layoutOwnerIsMain = false
    const { model } = bothOpen(FLOATING, localId(FLOATING))

    expect(owners(model, FLOATING)).toEqual([ENV])
  })
})
