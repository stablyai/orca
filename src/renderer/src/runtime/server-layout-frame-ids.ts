// Translate server layout IDs into this desktop's tab ids without remount: a server tab's desktop tab is the one saved as mirroring it, as in the snapshot mirror; layout.apply names it by that saved host tab. Frames lack handles, so bind each (host tab, leaf) from session.tabs.

import { toRuntimeExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'
import { toRemoteRuntimePtyId } from '../../../shared/remote-runtime/remote-runtime-pty-id'
import type { TabContentType } from '../../../shared/tab-types'
import { toWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'
import {
  mirroredTabContainers,
  type ContainerTab
} from './web-session-tabs-sync/mirrored-tab-containers'
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
  handleOf: ServerTerminalHandleOf,
  desktopId: string
): PublishedTab {
  const terminal = tabIdRule(tab.kind) === 'terminal'
  return {
    ...tab,
    id: desktopId,
    mirroredHostTab: { hostId: host, workspaceId: layout.worktreeId, tabId: tab.id },
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

/** What the codec reads of this desktop's tabs to keep their ids: the store's, or its last frame's. */
export type DesktopTabsOf = (
  worktreeId: string
) => readonly (ContainerTab &
  Pick<PublishedTab, 'entityId'> & { contentType?: string; kind?: string })[]

/** One workspace of a server's frames under this desktop's ids. A server tab's desktop tab is the
 *  one saved as mirroring it (`mirroredHostTab`), whatever it holds now, so a switch on the server
 *  keeps the desktop tab, its place and its selection. A tab saved before the association is adopted
 *  once by its old id (a terminal's `web-terminal-<terminal>`, anything else the server's id) or by
 *  what it holds; a new one takes that same id unless another tab has it. */
export function serverLayoutForDesktop(
  layout: PublishedWorkspaceLayout,
  environmentId: string,
  handleOf: ServerTerminalHandleOf,
  desktopTabs: ReturnType<DesktopTabsOf> = []
): PublishedWorkspaceLayout {
  const host = toRuntimeExecutionHostId(environmentId)
  const containers = mirroredTabContainers(desktopTabs, host, layout.worktreeId)
  const holderOf = new Map(
    desktopTabs.map((tab) => [`${tab.contentType ?? tab.kind}:${tab.entityId}`, tab])
  )
  const idOf = new Map(
    layout.tabs.map((tab) => {
      const terminal = tabIdRule(tab.kind) === 'terminal'
      const entityId = terminal ? toWebTerminalSurfaceTabId(tab.entityId) : tab.entityId
      const preferred = terminal ? entityId : tab.id
      return [
        tab.id,
        containers.resolve(tab.id, holderOf.get(`${tab.kind}:${entityId}`), preferred).id
      ]
    })
  )
  const tabId = (id: string) => idOf.get(id) ?? id
  return {
    ...layout,
    groups: layout.groups.map((group) => ({ ...group, tabIds: group.tabIds.map(tabId) })),
    tabs: layout.tabs.map((tab) =>
      desktopTab(tab, layout, host, environmentId, handleOf, tabId(tab.id))
    ),
    editorFiles: layout.editorFiles.map((file) => desktopEditorFile(file, environmentId)),
    browserTabs: layout.browserTabs
  }
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

/** One server stream's frames under desktop ids, and the changes a new terminal handle makes. */
export type ServerLayoutFrameTranslator = {
  translate: (frame: WorkspaceLayoutChangeFrame) => WorkspaceLayoutChangeFrame
  /** A records frame binding the panes whose handle session.tabs changed; null when none did. */
  rebind: (key: string) => WorkspaceLayoutRecordsFrame | null
  /** The workspaces the server's stream holds now. */
  keys: () => string[]
  /** The server tab a desktop tab mirrors (its saved `mirroredHostTab`); null when the latest
   *  frames hold no such tab. */
  serverTabId: (key: string, desktopTabId: string) => string | null
  /** The desktop tab mirroring a server tab; unchanged when the frames hold no such tab. */
  desktopTabId: (key: string, serverTabId: string) => string
  /** A workspace as the server publishes it, under the server's ids. */
  serverLayout: (key: string) => PublishedWorkspaceLayout | undefined
}

/** Retain server workspace copies and re-diff under desktop IDs; group/tab references depend on records a single delta may omit. */
export function createServerLayoutFrameTranslator(
  environmentId: string,
  handleOf: (worktreeId: string) => ServerTerminalHandleOf,
  /** This desktop's tabs of a workspace (the store's, saved relations included); the translator's
   *  own last frame when none are given. */
  desktopTabsOf?: DesktopTabsOf
): ServerLayoutFrameTranslator {
  const server = new Map<string, PublishedWorkspaceLayout>()
  const desktop = new Map<string, Translated>()
  /** The last server frame's stream identity, which a desktop-made frame repeats. */
  let position = { epoch: '', seq: 0 }

  const show = (key: string, layout: PublishedWorkspaceLayout): Translated => {
    const translated = serverLayoutForDesktop(
      layout,
      environmentId,
      handleOf(layout.worktreeId),
      desktopTabsOf?.(key) ?? desktop.get(key)?.layout.tabs ?? []
    )
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
    serverTabId: (key, desktopTabId) =>
      desktop.get(key)?.layout.tabs.find((tab) => tab.id === desktopTabId)?.mirroredHostTab
        ?.tabId ?? null,
    desktopTabId: (key, serverTabId) =>
      desktop.get(key)?.layout.tabs.find((tab) => tab.mirroredHostTab?.tabId === serverTabId)?.id ??
      serverTabId,
    serverLayout: (key) => server.get(key),
    rebind: (key) => {
      const layout = server.get(key)
      const workspaces = layout ? changeTo(key, layout) : []
      return workspaces.length > 0 ? { type: 'records', ...position, workspaces } : null
    }
  }
}

type Translated = { layout: PublishedWorkspaceLayout; index: IndexedLayoutRecords | null }
