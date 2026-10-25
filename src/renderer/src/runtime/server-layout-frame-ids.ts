// A paired server's layout frames under the ids this desktop already gives that server's tabs (the
// session.tabs mirror's), so a workspace moves between the two sources without a remount. The one
// place server ids become desktop ids; layout.apply maps back through the same rules. Frames carry
// no terminal handle: a pane binds the handle session.tabs gives its (host tab, leaf) surface.

import {
  LOCAL_EXECUTION_HOST_ID,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import { toRemoteRuntimePtyId } from '../../../shared/remote-runtime-pty-id'
import type { TabContentType } from '../../../shared/tab-types'
import {
  isWebTerminalSurfaceTabId,
  toHostSessionTabId,
  toWebTerminalSurfaceTabId
} from '../../../shared/terminal-surface-id'
import { ownedEditorFileId } from '../../../shared/workspace-session-pane-ownership'
import type {
  PublishedEditorFile,
  PublishedPane,
  PublishedTab,
  PublishedWorkspaceLayout
} from '../../../shared/workspace-layout/workspace-layout-published'
import {
  applyWorkspaceLayoutRecordChange,
  diffPublishedLayouts,
  indexPublishedLayout,
  type IndexedLayoutRecords,
  type WorkspaceLayoutRecordChange
} from '../../../shared/workspace-layout/workspace-layout-records'
import type {
  WorkspaceLayoutChangeFrame,
  WorkspaceLayoutRecordsFrame
} from '../../../shared/workspace-layout/workspace-layout-stream-frames'

/** Which tab ids a kind changes: a terminal's take the mirror's surface prefix, others keep theirs. */
const TAB_ID_RULES: Record<TabContentType, 'terminal' | 'kept'> = {
  terminal: 'terminal',
  editor: 'kept',
  diff: 'kept',
  'conflict-review': 'kept',
  'check-details': 'kept',
  'agent-session': 'kept',
  browser: 'kept',
  simulator: 'kept'
}

function isKnownTabKind(kind: string): kind is TabContentType {
  return Object.hasOwn(TAB_ID_RULES, kind)
}

function tabIdRule(kind: string): 'terminal' | 'kept' {
  const rule = isKnownTabKind(kind) ? TAB_ID_RULES[kind] : undefined
  if (!rule) {
    // A newer server's tab kind: drawing it under raw ids would mix two id spaces.
    throw new Error(`server layout: unknown tab kind ${kind}`)
  }
  return rule
}

/** A server editor tab names its file by path or by owned id; the desktop always uses the owned id. */
function desktopEditorEntityId(
  entityId: string,
  layout: PublishedWorkspaceLayout,
  environmentId: string
): string {
  const filePath =
    layout.editorFiles.find(
      (candidate) =>
        ownedEditorFileId(candidate.filePath, layout.worktreeId, candidate.runtimeEnvironmentId) ===
        entityId
    )?.filePath ??
    // Why only the path: every desktop record of a server file is owned by that server, whichever server record a bare path names.
    (layout.editorFiles.some((candidate) => candidate.filePath === entityId) ? entityId : null)
  return filePath === null
    ? entityId
    : ownedEditorFileId(filePath, layout.worktreeId, environmentId)
}

/** The handle session.tabs gives a server terminal tab's pane; null while it has none. */
export type ServerTerminalHandleOf = (hostTabId: string, leafId: string) => string | null

function desktopPane(
  pane: PublishedPane,
  hostTabId: string,
  environmentId: string,
  handleOf: ServerTerminalHandleOf
): PublishedPane {
  const { ptyId, ptyGeneration, ...rest } = pane
  const handle = ptyId ? handleOf(hostTabId, pane.leafId) : null
  // A bound pane without a handle yet shows as pending, as the mirror's `pending-handle` does.
  return handle
    ? {
        ...rest,
        ptyId: toRemoteRuntimePtyId(handle, environmentId),
        ...(ptyGeneration !== undefined ? { ptyGeneration } : {})
      }
    : rest
}

function desktopTab(
  tab: PublishedTab,
  layout: PublishedWorkspaceLayout,
  host: ExecutionHostId,
  environmentId: string,
  handleOf: ServerTerminalHandleOf
): PublishedTab {
  const terminal = tabIdRule(tab.kind) === 'terminal'
  return {
    ...tab,
    // The mirror names a terminal tab by its terminal's id alone, tab-bar entry included.
    id: terminal ? toWebTerminalSurfaceTabId(tab.entityId) : tab.id,
    entityId: terminal
      ? toWebTerminalSurfaceTabId(tab.entityId)
      : tab.kind === 'editor'
        ? desktopEditorEntityId(tab.entityId, layout, environmentId)
        : tab.entityId,
    executionHostId: host,
    ...(tab.terminal
      ? {
          terminal: {
            ...tab.terminal,
            panes: tab.terminal.panes.map((pane) =>
              desktopPane(pane, tab.entityId, environmentId, handleOf)
            )
          }
        }
      : {})
  }
}

function desktopEditorFile(file: PublishedEditorFile, environmentId: string): PublishedEditorFile {
  // The server's SSH target names a host of the server's, never one of this desktop's.
  const { externalSshTargetId: _serverTarget, ...rest } = file
  return { ...rest, runtimeEnvironmentId: environmentId }
}

/** One workspace of a server's frames under this desktop's ids. */
export function serverLayoutForDesktop(
  layout: PublishedWorkspaceLayout,
  environmentId: string,
  handleOf: ServerTerminalHandleOf
): PublishedWorkspaceLayout {
  const host = toRuntimeExecutionHostId(environmentId)
  const terminalEntityByTabId = new Map(
    layout.tabs
      .filter((tab) => tabIdRule(tab.kind) === 'terminal')
      .map((tab) => [tab.id, tab.entityId])
  )
  const tabId = (id: string) => {
    const entityId = terminalEntityByTabId.get(id)
    return entityId === undefined ? id : toWebTerminalSurfaceTabId(entityId)
  }
  return {
    ...layout,
    groups: layout.groups.map((group) => ({ ...group, tabIds: group.tabIds.map(tabId) })),
    tabs: layout.tabs.map((tab) => desktopTab(tab, layout, host, environmentId, handleOf)),
    editorFiles: layout.editorFiles.map((file) => desktopEditorFile(file, environmentId)),
    browserTabs: layout.browserTabs
  }
}

/** A desktop tab id as the server knows it. */
export function serverTabIdOf(desktopTabId: string): string {
  return isWebTerminalSurfaceTabId(desktopTabId) ? toHostSessionTabId(desktopTabId) : desktopTabId
}

/** A desktop editor file id as the server knows it: its own file, owned by no environment; unchanged
 *  when no record names it (`desktopEditorEntityId` then hands it back unchanged too). */
export function serverEditorFileId(
  fileId: string,
  worktreeId: string,
  files: readonly Pick<PublishedEditorFile, 'filePath' | 'runtimeEnvironmentId'>[]
): string {
  const file = files.find(
    (candidate) =>
      ownedEditorFileId(candidate.filePath, worktreeId, candidate.runtimeEnvironmentId) === fileId
  )
  return file ? ownedEditorFileId(file.filePath, worktreeId, undefined) : fileId
}

function serverEditorEntityId(entityId: string, layout: PublishedWorkspaceLayout): string {
  return serverEditorFileId(entityId, layout.worktreeId, layout.editorFiles)
}

/**
 * A desktop-shaped workspace under the server's ids: the inverse of `serverLayoutForDesktop`, except
 * that an editor tab the server named by path comes back under the server's owned id for that file.
 * Panes keep no terminal: the desktop binds handles, which the server never takes.
 */
export function desktopLayoutForServer(layout: PublishedWorkspaceLayout): PublishedWorkspaceLayout {
  return {
    ...layout,
    groups: layout.groups.map((group) => ({ ...group, tabIds: group.tabIds.map(serverTabIdOf) })),
    tabs: layout.tabs.map((tab) => {
      tabIdRule(tab.kind)
      return {
        ...tab,
        id: serverTabIdOf(tab.id),
        entityId:
          tab.kind === 'editor'
            ? serverEditorEntityId(tab.entityId, layout)
            : serverTabIdOf(tab.entityId),
        executionHostId: LOCAL_EXECUTION_HOST_ID,
        ...(tab.terminal
          ? {
              terminal: {
                ...tab.terminal,
                panes: tab.terminal.panes.map(
                  ({ ptyId: _handle, ptyGeneration: _g, ...pane }) => pane
                )
              }
            }
          : {})
      }
    }),
    editorFiles: layout.editorFiles.map(({ runtimeEnvironmentId: _env, ...file }) => file)
  }
}

/** One server stream's frames under desktop ids, and the changes a new terminal handle makes. */
export type ServerLayoutFrameTranslator = {
  translate: (frame: WorkspaceLayoutChangeFrame) => WorkspaceLayoutChangeFrame
  /** A records frame binding the panes whose handle session.tabs changed; null when none did. */
  rebind: (key: string) => WorkspaceLayoutRecordsFrame | null
  /** The workspaces the server's stream holds now. */
  keys: () => string[]
  /** A desktop tab id as this server's latest frames name it; null when they hold no such tab. */
  serverTabId: (key: string, desktopTabId: string) => string | null
  /** A server tab id under desktop ids; unchanged when the frames hold no such tab. */
  desktopTabId: (key: string, serverTabId: string) => string
  /** A workspace as the server publishes it, under the server's ids. */
  serverLayout: (key: string) => PublishedWorkspaceLayout | undefined
}

/**
 * Translates one server stream's frames in order. It keeps the server's copy of each workspace, so
 * a records frame is re-diffed under desktop ids: a record's key can depend on another record (a
 * group names terminal tabs by their kind), which one frame alone may not carry.
 */
export function createServerLayoutFrameTranslator(
  environmentId: string,
  handleOf: (worktreeId: string) => ServerTerminalHandleOf
): ServerLayoutFrameTranslator {
  const server = new Map<string, PublishedWorkspaceLayout>()
  const desktop = new Map<string, Translated>()
  /** The last server frame's stream identity, which a desktop-made frame repeats. */
  let position = { epoch: '', seq: 0 }

  const show = (key: string, layout: PublishedWorkspaceLayout): Translated => {
    const translated = serverLayoutForDesktop(layout, environmentId, handleOf(layout.worktreeId))
    const entry = { layout: translated, index: indexPublishedLayout(translated) }
    server.set(key, layout)
    desktop.set(key, entry)
    return entry
  }
  const drop = (key: string): void => {
    server.delete(key)
    desktop.delete(key)
  }
  const changeTo = (
    key: string,
    layout: PublishedWorkspaceLayout
  ): WorkspaceLayoutRecordChange[] => {
    const before = desktop.get(key)
    const after = show(key, layout)
    const diff = diffPublishedLayouts(key, before?.index ?? null, after.index, after.layout)
    return diff ? [diff] : []
  }

  const recordChange = (change: WorkspaceLayoutRecordChange): WorkspaceLayoutRecordChange[] => {
    if (change.change === 'removed') {
      drop(change.key)
      return [change]
    }
    if (change.change === 'layout') {
      return [{ ...change, layout: show(change.key, change.layout).layout }]
    }
    // Throws for a change that does not fit: the stream then resubscribes for a snapshot.
    return changeTo(change.key, applyWorkspaceLayoutRecordChange(server.get(change.key), change)!)
  }

  return {
    translate: (frame) => {
      switch (frame.type) {
        case 'snapshot':
          server.clear()
          desktop.clear()
          position = { epoch: frame.epoch ?? '', seq: frame.seq ?? 0 }
          return {
            ...frame,
            workspaces: frame.workspaces.map(({ key, layout }) => ({
              key,
              layout: show(key, layout).layout
            }))
          }
        case 'workspace':
          return { ...frame, layout: show(frame.key, frame.layout).layout }
        case 'removed':
          drop(frame.key)
          return frame
        case 'records':
          position = { epoch: frame.epoch, seq: frame.seq }
          return { ...frame, workspaces: frame.workspaces.flatMap(recordChange) }
      }
    },
    keys: () => [...server.keys()],
    // Both copies list the same tabs in the same order (serverLayoutForDesktop maps one to one).
    serverTabId: (key, desktopTabId) => {
      const index = desktop.get(key)?.layout.tabs.findIndex((tab) => tab.id === desktopTabId) ?? -1
      return index < 0 ? null : (server.get(key)?.tabs[index]?.id ?? null)
    },
    desktopTabId: (key, serverTabId) => {
      const index = server.get(key)?.tabs.findIndex((tab) => tab.id === serverTabId) ?? -1
      return index < 0 ? serverTabId : (desktop.get(key)?.layout.tabs[index]?.id ?? serverTabId)
    },
    serverLayout: (key) => server.get(key),
    rebind: (key) => {
      const layout = server.get(key)
      const workspaces = layout ? changeTo(key, layout) : []
      return workspaces.length > 0 ? { type: 'records', ...position, workspaces } : null
    }
  }
}

type Translated = { layout: PublishedWorkspaceLayout; index: IndexedLayoutRecords | null }
