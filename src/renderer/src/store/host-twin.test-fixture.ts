/**
 * Twins: one repo (or folder workspace) registered on two execution hosts. They share the repo
 * id, the worktree id and every raw-id-keyed store bucket, so an action aimed at one twin can
 * silently reach the other. The fixture seeds both twins with live shells, a dormant tab, dirty
 * documents, drafts and sleeping-agent records; `host-twin-state-projection.test-fixture.ts` reads one host back.
 */
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { Repo } from '../../../shared/repo-types'
import type { ProjectGroup } from '../../../shared/project-group-types'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import { toRemoteRuntimePtyId } from '../../../shared/remote-runtime-pty-id'
import { toAppSshPtyId } from '../../../shared/ssh-pty-id'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import {
  createTestStore,
  makeOpenFile,
  makeTab,
  makeTabGroup,
  makeUnifiedTab,
  makeWorktree
} from './slices/store-test-helpers'
import { makeFolderWorkspace } from './slices/worktrees-slice-test-fixtures'
import { updateNativeChatComposerDraft } from '@/components/native-chat/native-chat-composer-draft-store'
import { markWorktreeSleepIntent } from '@/lib/worktree-sleep-intent'
import {
  beginHugeRepoWarningProbe,
  markHugeRepoWarningDismissed,
  type HugeRepoWarningProbe
} from '@/lib/source-control-huge-repo-warning-dismissals'

export type HostTwinKind =
  | 'local+ssh'
  | 'local+runtime'
  | 'folder local+ssh'
  // One unstamped folder row whose project group both hosts publish.
  | 'folder group local+ssh'

export const TWIN_SSH_TARGET = 'conn-b'
export const TWIN_RUNTIME_ENV = 'env-b'
const PROJECT_ID = 'twin-repo'
const FOLDER_ID = 'twin-folder'
const GROUP_ID = 'twin-group'
const TAB_GROUP_ID = 'twin-tab-group'
const LEAF = 'leaf-1'

/** What one host owns in the fixture; everything else in a shared bucket is the other host's or shared. */
export type HostTwinSide = {
  hostId: ExecutionHostId
  terminalTabId: string
  ptyId: string
  fileId: string
  paneKey: string
}

export type HostTwinFixture = {
  kind: HostTwinKind
  store: ReturnType<typeof createTestStore>
  /** Repo id, or the folder workspace id for folder twins. */
  projectId: string
  /** The key both twins' tabs live under: the worktree id or the folder workspace key. */
  workspaceKey: string
  local: HostTwinSide
  remote: HostTwinSide
  /** A tab with no PTY: no evidence names its host, so it is kept while either twin survives. */
  dormantTabId: string
  hugeRepoWarningProbe: HugeRepoWarningProbe
}

function remoteHostFor(kind: HostTwinKind): ExecutionHostId {
  return kind === 'local+runtime' ? `runtime:${TWIN_RUNTIME_ENV}` : `ssh:${TWIN_SSH_TARGET}`
}

function remotePtyIdFor(kind: HostTwinKind): string {
  return kind === 'local+runtime'
    ? toRemoteRuntimePtyId('handle-b', TWIN_RUNTIME_ENV)
    : toAppSshPtyId(TWIN_SSH_TARGET, 'pty-b')
}

function side(hostId: ExecutionHostId, tag: string, ptyId: string, root: string): HostTwinSide {
  const terminalTabId = `tab-${tag}`
  return {
    hostId,
    terminalTabId,
    ptyId,
    fileId: `${root}/${tag}.ts`,
    paneKey: `${terminalTabId}:${LEAF}`
  }
}

function repoRow(executionHostId: ExecutionHostId, root: string): Repo {
  return {
    id: PROJECT_ID,
    path: root,
    displayName: 'Twin',
    badgeColor: '#000',
    addedAt: 1,
    executionHostId,
    ...(executionHostId.startsWith('ssh:') ? { connectionId: TWIN_SSH_TARGET } : {})
  }
}

function projectGroupRow(executionHostId: ExecutionHostId): ProjectGroup {
  return {
    id: GROUP_ID,
    name: 'Twin group',
    parentPath: '/work/twin',
    executionHostId,
    ...(executionHostId.startsWith('ssh:') ? { connectionId: TWIN_SSH_TARGET } : {}),
    parentGroupId: null,
    createdFrom: 'folder-scan',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 1,
    updatedAt: 1
  }
}

function sleepingRecord(
  sideOf: HostTwinSide,
  workspaceKey: string,
  connectionId: string | null
): SleepingAgentSessionRecord {
  return {
    paneKey: sideOf.paneKey,
    worktreeId: workspaceKey,
    agent: 'claude',
    providerSession: { key: 'session_id', id: sideOf.paneKey },
    prompt: '',
    state: 'done',
    capturedAt: 1,
    updatedAt: 1,
    connectionId
  }
}

export function createHostTwinFixture(kind: HostTwinKind): HostTwinFixture {
  const store = createTestStore()
  const root = '/work/twin'
  const isFolder = kind === 'folder local+ssh' || kind === 'folder group local+ssh'
  const projectId = isFolder ? FOLDER_ID : PROJECT_ID
  const workspaceKey = isFolder ? folderWorkspaceKey(FOLDER_ID) : `${PROJECT_ID}::${root}`
  const remoteHostId = remoteHostFor(kind)
  const local = side('local', 'local', 'pty-local', root)
  const remote = side(remoteHostId, 'remote', remotePtyIdFor(kind), root)
  const dormantTabId = 'tab-dormant'
  const sides = [local, remote]
  const tab = (id: string, ptyId: string | null) => makeTab({ id, worktreeId: workspaceKey, ptyId })
  const unified = (
    id: string,
    executionHostId: ExecutionHostId,
    contentType: 'terminal' | 'editor'
  ) =>
    makeUnifiedTab({
      id,
      worktreeId: workspaceKey,
      groupId: TAB_GROUP_ID,
      executionHostId,
      contentType
    })

  store.setState({
    ...(isFolder
      ? {
          projectGroups: [projectGroupRow('local'), projectGroupRow(remoteHostId)],
          folderWorkspaces:
            kind === 'folder group local+ssh'
              ? [makeFolderWorkspace({ id: FOLDER_ID, projectGroupId: GROUP_ID, folderPath: root })]
              : [
                  makeFolderWorkspace({
                    id: FOLDER_ID,
                    projectGroupId: GROUP_ID,
                    folderPath: root,
                    executionHostId: 'local'
                  }),
                  makeFolderWorkspace({
                    id: FOLDER_ID,
                    projectGroupId: GROUP_ID,
                    folderPath: root,
                    executionHostId: remoteHostId,
                    connectionId: TWIN_SSH_TARGET
                  })
                ]
        }
      : {
          repos: [repoRow('local', root), repoRow(remoteHostId, root)],
          worktreesByRepo: {
            [PROJECT_ID]: [
              makeWorktree({
                id: workspaceKey,
                repoId: PROJECT_ID,
                path: root,
                hostId: 'local'
              }),
              makeWorktree({
                id: workspaceKey,
                repoId: PROJECT_ID,
                path: root,
                hostId: remoteHostId
              })
            ]
          }
        }),
    tabsByWorktree: {
      [workspaceKey]: [...sides.map((s) => tab(s.terminalTabId, s.ptyId)), tab(dormantTabId, null)]
    },
    ptyIdsByTabId: Object.fromEntries(sides.map((s) => [s.terminalTabId, [s.ptyId]])),
    terminalLayoutsByTabId: Object.fromEntries(
      sides.map((s) => [
        s.terminalTabId,
        {
          root: { type: 'leaf', leafId: LEAF },
          activeLeafId: LEAF,
          expandedLeafId: null,
          ptyIdsByLeafId: { [LEAF]: s.ptyId }
        }
      ])
    ),
    unifiedTabsByWorktree: {
      [workspaceKey]: [
        ...sides.flatMap((s) => [
          unified(s.terminalTabId, s.hostId, 'terminal'),
          unified(s.fileId, s.hostId, 'editor')
        ]),
        makeUnifiedTab({
          id: dormantTabId,
          worktreeId: workspaceKey,
          groupId: TAB_GROUP_ID
        })
      ]
    },
    groupsByWorktree: {
      [workspaceKey]: [
        makeTabGroup({
          id: TAB_GROUP_ID,
          worktreeId: workspaceKey,
          activeTabId: local.terminalTabId,
          tabOrder: [...sides.flatMap((s) => [s.terminalTabId, s.fileId]), dormantTabId]
        })
      ]
    },
    openFiles: sides.map((s) =>
      makeOpenFile({
        id: s.fileId,
        worktreeId: workspaceKey,
        isDirty: true,
        ...(s.hostId.startsWith('runtime:') ? { runtimeEnvironmentId: TWIN_RUNTIME_ENV } : {})
      })
    ),
    editorDrafts: Object.fromEntries(sides.map((s) => [s.fileId, `unsaved ${s.hostId} edit`])),
    sleepingAgentSessionsByPaneKey: Object.fromEntries(
      sides.map((s) => [
        s.paneKey,
        sleepingRecord(s, workspaceKey, s.hostId.startsWith('ssh:') ? TWIN_SSH_TARGET : null)
      ])
    )
  })
  for (const s of sides) {
    updateNativeChatComposerDraft(s.paneKey, { text: `${s.hostId} chat draft` }, 'deferred')
  }
  // Raw-id module stores: neither can say which twin wrote it, so each belongs to both.
  markWorktreeSleepIntent(workspaceKey)
  const hugeRepoWarningProbe = beginHugeRepoWarningProbe({ id: workspaceKey })
  markHugeRepoWarningDismissed(hugeRepoWarningProbe)
  return {
    kind,
    store,
    projectId,
    workspaceKey,
    local,
    remote,
    dormantTabId,
    hugeRepoWarningProbe
  }
}
