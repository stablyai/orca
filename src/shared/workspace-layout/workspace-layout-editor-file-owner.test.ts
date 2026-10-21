// A local file and a runtime-environment file at one path in one workspace are two records: each
// open, reload, move and close touches its own owner's record only.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../constants'
import { LOCAL_EXECUTION_HOST_ID } from '../execution-host'
import { ownedEditorFileId } from '../workspace-session-pane-ownership'
import type { PersistedOpenFile, WorkspaceSessionState } from '../workspace-session-state-types'
import { applyLayoutCommand } from './workspace-layout-commands'
import type { CommandOf } from './workspace-layout-command-types'
import { build, testContext } from './workspace-layout-command.test-fixture'
import { editorTabFile } from './workspace-layout-editor-tab-file'
import { loadWorkspaceLayout } from './workspace-layout-load'
import { diffStoredSession } from './workspace-layout-load-report'
import type { LayoutEditorFile, WorkspaceLayoutModel } from './workspace-layout-model'
import { publishWorkspaceLayout } from './workspace-layout-published'
import { patchStoredSession } from './workspace-layout-record-patch'
import { saveWorkspaceLayout } from './workspace-layout-save'
import { addWorkspace, emptySession, GIT_KEY } from './workspace-layout-session.test-fixture'

const mocks = vi.hoisted(() => ({ layoutOwnerIsMain: true }))
vi.mock('../layout-owner-switch', () => ({
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

function persisted(key: string, file: LayoutEditorFile, draft: string): PersistedOpenFile {
  return { ...file, worktreeId: key, dirtyDraftContent: draft }
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

  it('a reload keeps both records, each with its own unsaved draft', () => {
    const stored: WorkspaceSessionState = addWorkspace(emptySession(), FLOATING, [
      {
        id: 'group-1',
        tabs: [
          { id: localId(FLOATING), kind: 'editor' },
          { id: runtimeId(FLOATING), kind: 'editor' }
        ]
      }
    ])
    stored.openFilesByWorktree = {
      [FLOATING]: [
        persisted(FLOATING, LOCAL_FILE, 'local draft'),
        persisted(FLOATING, RUNTIME_FILE, 'runtime draft')
      ]
    }
    let id = 0
    const loaded = loadWorkspaceLayout(LOCAL_EXECUTION_HOST_ID, stored, {
      mintId: () => `minted-${++id}`,
      mintLeafId: () => `00000000-0000-4000-8000-${String(++id).padStart(12, '0')}`
    })

    const saved = saveWorkspaceLayout(loaded)

    expect(saved.openFilesByWorktree?.[FLOATING]).toEqual(stored.openFilesByWorktree[FLOATING])
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

  it('a path-id tab names the local record when the runtime record is listed first', () => {
    const { model } = build(testContext(), [
      open(GIT_KEY, runtimeId(GIT_KEY), RUNTIME_FILE),
      open(GIT_KEY, PATH, LOCAL_FILE)
    ])
    const workspace = model.workspaces[GIT_KEY]!
    const hostOf = (entityId: string) =>
      publishWorkspaceLayout(workspace, LOCAL_EXECUTION_HOST_ID).tabs.find(
        (tab) => tab.entityId === entityId
      )?.executionHostId

    expect(owners(model, GIT_KEY)).toEqual([ENV, 'local'])
    expect(editorTabFile(workspace, PATH)?.runtimeEnvironmentId).toBeUndefined()
    expect(hostOf(PATH)).toBe(LOCAL_EXECUTION_HOST_ID)
    expect(hostOf(runtimeId(GIT_KEY))).toBe(`runtime:${ENV}`)
  })

  it("the load report sees a change to one owner's record of a shared path", () => {
    const local = { ...LOCAL_FILE, worktreeId: FLOATING }
    const runtime = { ...RUNTIME_FILE, worktreeId: FLOATING }
    const session = (files: PersistedOpenFile[]): WorkspaceSessionState => ({
      ...emptySession(),
      openFilesByWorktree: { [FLOATING]: files }
    })

    const changes = diffStoredSession(session([local, runtime]), session([runtime]))

    expect(changes.filter((change) => change.table === 'file')).toEqual([
      expect.objectContaining({ field: '*', before: local, after: undefined })
    ])
  })

  it("a reload keeps a path-id preview tab's flag on its own owner's record only", () => {
    const stored: WorkspaceSessionState = addWorkspace(emptySession(), GIT_KEY, [
      {
        id: 'group-1',
        tabs: [
          { id: PATH, kind: 'editor', entry: { isPreview: true } },
          { id: runtimeId(GIT_KEY), kind: 'editor' }
        ]
      }
    ])
    stored.openFilesByWorktree = {
      [GIT_KEY]: [
        { ...RUNTIME_FILE, worktreeId: GIT_KEY },
        { ...LOCAL_FILE, worktreeId: GIT_KEY, isPreview: true }
      ]
    }
    let id = 0
    const loaded = loadWorkspaceLayout(LOCAL_EXECUTION_HOST_ID, stored, {
      mintId: () => `minted-${++id}`,
      mintLeafId: () => `00000000-0000-4000-8000-${String(++id).padStart(12, '0')}`
    })
    const tabs = loaded.layout.workspaces[GIT_KEY]!.tabs

    expect(tabs.map((tab) => tab.isPreview)).toEqual([true, undefined])
    expect(saveWorkspaceLayout(loaded).openFilesByWorktree?.[GIT_KEY]).toEqual(
      stored.openFilesByWorktree[GIT_KEY]
    )
  })

  it('match by path alone when the switch is off, as a headless host does today', () => {
    mocks.layoutOwnerIsMain = false
    const { model } = bothOpen(FLOATING, localId(FLOATING))

    expect(owners(model, FLOATING)).toEqual([ENV])
  })
})
