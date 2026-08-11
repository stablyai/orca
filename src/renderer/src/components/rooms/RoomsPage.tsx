import { useContext, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertCircle, MessagesSquare } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { useShallow } from 'zustand/react/shallow'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { getActiveRuntimeTarget, settingsForRuntimeOwner } from '@/runtime/runtime-rpc-client'
import type { RoomMessage } from '../../../../shared/rooms'
import { getActiveSidebarWorkspaceId, parseWorkspaceKey } from '../../../../shared/workspace-scope'
import { getWorktreeExecutionHostId } from '../../../../shared/execution-host'
import { selectRepoByIdForActiveWorkspace, useWorktreesForRepo } from '@/store/selectors'
import { useRoomData } from './use-room-data'
import { RoomParticipantBar } from './RoomParticipantBar'
import { RoomMessageFeed } from './RoomMessageFeed'
import { RoomComposer } from './RoomComposer'
import { RoomInspector } from './RoomInspector'
import { RoomAddAgentDialog } from './RoomAddAgentDialog'
import { RoomSettingsDialog } from './RoomSettingsDialog'
import { exportRoomArchive, importRoomArchive } from './room-archive-transfer'
import { roomRpc } from '@/runtime/runtime-rooms-client'
import { showRoomActionError } from './room-action-error'
import {
  AgentSubagentProvider,
  type AgentSubagentSource
} from '../agent-subagents/AgentSubagentProvider'
import { RoomInspectorPortalContext } from './room-inspector-portal'

const EMPTY_SUBAGENTS = [] as const

export default function RoomsPage({ roomId }: { roomId: string }): React.JSX.Element {
  useTranslation()
  const inspectorTarget = useContext(RoomInspectorPortalContext)
  const activeRepoId = useAppStore((state) => state.activeRepoId)
  const activeWorkspaceKey = useAppStore((state) => state.activeWorkspaceKey)
  const activeWorktreeId = useAppStore((state) => state.activeWorktreeId)
  const activeHostId = useAppStore((state) => state.activeWorkspaceExecutionHostId)
  const workspaceId = getActiveSidebarWorkspaceId(activeWorkspaceKey, activeWorktreeId)
  const worktreeOwner = useAppStore((state) =>
    workspaceId
      ? (state.getKnownWorktreeById(workspaceId, activeHostId ?? undefined) ?? null)
      : null
  )
  const workspaceScope = parseWorkspaceKey(activeWorkspaceKey ?? '')
  const projectRepoId =
    activeRepoId ?? (workspaceScope?.type === 'worktree' ? (worktreeOwner?.repoId ?? null) : null)
  const repo = useAppStore((state) => selectRepoByIdForActiveWorkspace(state, projectRepoId))
  const repoWorktrees = useWorktreesForRepo(projectRepoId)
  const settings = useAppStore((state) => state.settings)
  const projectId = roomProjectId(projectRepoId, activeWorkspaceKey)
  const worktrees = useMemo(
    () =>
      workspaceScope?.type === 'folder'
        ? worktreeOwner
          ? [worktreeOwner]
          : []
        : repoWorktrees.filter(
            (worktree) =>
              !activeHostId ||
              getWorktreeExecutionHostId(worktree, repo ?? undefined) === activeHostId
          ),
    [activeHostId, repo, repoWorktrees, workspaceScope?.type, worktreeOwner]
  )
  const target = useMemo(
    () =>
      getActiveRuntimeTarget(
        settingsForRuntimeOwner(settings, worktreeOwner?.runtimeOwnerEnvironmentId)
      ),
    [settings, worktreeOwner?.runtimeOwnerEnvironmentId]
  )
  const data = useRoomData(target, projectId, roomId)
  const participants = useMemo(
    () => data.snapshot?.participants ?? [],
    [data.snapshot?.participants]
  )
  const liveSubagentsByPaneKey = useAppStore(
    useShallow((state) =>
      Object.fromEntries(
        participants.flatMap((participant) =>
          participant.paneKey
            ? [
                [
                  participant.paneKey,
                  state.agentStatusByPaneKey[participant.paneKey]?.subagents ?? EMPTY_SUBAGENTS
                ]
              ]
            : []
        )
      )
    )
  )
  const subagentSources = useMemo<AgentSubagentSource[]>(
    () =>
      participants.flatMap((participant) =>
        participant.actorKind === 'agent' && participant.agent
          ? [
              {
                key: participant.id,
                identity: participant.identity,
                agent: participant.agent,
                paneKey: participant.paneKey ?? `room:${participant.id}`,
                sessionId: participant.providerSession?.id ?? null,
                transcriptPath: participant.providerSession?.transcriptPath ?? null,
                runtimeEnvironmentId:
                  data.target.kind === 'environment' ? data.target.environmentId : null,
                target: data.target,
                liveSubagents: participant.paneKey
                  ? (liveSubagentsByPaneKey[participant.paneKey] ?? [])
                  : [],
                working: Boolean(data.activities[participant.id])
              }
            ]
          : []
      ),
    [data.activities, data.target, liveSubagentsByPaneKey, participants]
  )
  const [addAgentOpen, setAddAgentOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [transferring, setTransferring] = useState(false)
  const [reply, setReply] = useState<RoomMessage | null>(null)
  const archiveInputRef = useRef<HTMLInputElement>(null)

  const exportArchive = async (): Promise<void> => {
    if (!data.roomId || transferring) {
      return
    }
    setTransferring(true)
    const toastId = toast.loading(
      translate('rooms.archive.preparingExport', 'Preparing room archive…')
    )
    try {
      const destination = await exportRoomArchive(data.target, data.roomId, (done, total) =>
        toast.loading(
          translate('rooms.archive.exportProgress', 'Exporting room… {{percent}}%', {
            percent: Math.round((done / total) * 100)
          }),
          { id: toastId }
        )
      )
      if (destination) {
        toast.success(translate('rooms.archive.saved', 'Room archive saved'), { id: toastId })
      } else {
        toast.dismiss(toastId)
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error), { id: toastId })
    } finally {
      setTransferring(false)
    }
  }

  const importArchive = async (file: File): Promise<void> => {
    if (!data.roomId || transferring) {
      return
    }
    setTransferring(true)
    const toastId = toast.loading(translate('rooms.archive.importing', 'Importing room…'))
    try {
      await importRoomArchive(data.target, data.roomId, file, (done, total) =>
        toast.loading(
          translate('rooms.archive.importProgress', 'Importing room… {{percent}}%', {
            percent: Math.round((done / total) * 100)
          }),
          { id: toastId }
        )
      )
      toast.success(translate('rooms.archive.imported', 'Room archive imported'), { id: toastId })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error), { id: toastId })
    } finally {
      setTransferring(false)
      if (archiveInputRef.current) {
        archiveInputRef.current.value = ''
      }
    }
  }

  if (!projectId || (!repo && !worktreeOwner)) {
    return (
      <EmptyState
        title={translate('rooms.page.selectProject', 'Select a project')}
        description={translate(
          'rooms.page.selectProjectDescription',
          'Rooms belong to a project and can use any of its worktrees.'
        )}
      />
    )
  }
  if (!data.loading && data.rooms.length === 0) {
    return (
      <EmptyState
        title={translate('rooms.page.empty', 'No rooms yet')}
        description={translate('rooms.page.emptyDescription', 'Create a room for {{name}}.', {
          name: repo?.displayName ?? worktreeOwner?.displayName ?? ''
        })}
      />
    )
  }
  return (
    <AgentSubagentProvider sources={subagentSources}>
      <main className="flex min-h-0 flex-1 bg-background" data-testid="rooms-page">
        <section className="flex min-w-0 flex-1 flex-col">
          <RoomParticipantBar
            data={data}
            onAdd={() => setAddAgentOpen(true)}
            onSettings={() => setSettingsOpen(true)}
            onExport={() => void exportArchive()}
            onImport={() => archiveInputRef.current?.click()}
            onArchiveToggle={() => {
              const room = data.snapshot?.room
              if (room) {
                void roomRpc(data.target, 'rooms.update', {
                  roomId: room.id,
                  archived: !room.archivedAt
                }).catch(showRoomActionError)
              }
            }}
            transferring={transferring}
          />
          {data.error ? (
            <div className="flex items-center gap-2 border-b border-destructive/20 bg-destructive/5 px-3 py-1.5 text-xs text-destructive">
              <AlertCircle className="size-3.5" />
              {data.error}
            </div>
          ) : null}
          <RoomMessageFeed key={data.roomId ?? 'none'} data={data} onReply={setReply} />
          {data.snapshot?.room.archivedAt ? (
            <div className="border-t border-border p-3 text-center text-xs text-muted-foreground">
              {translate(
                'rooms.page.archived',
                'This room is archived. Restore it from the room menu to continue.'
              )}
            </div>
          ) : (
            <RoomComposer data={data} reply={reply} onReplyChange={setReply} />
          )}
        </section>
        {inspectorTarget
          ? createPortal(
              <RoomInspector data={data} onAddAgent={() => setAddAgentOpen(true)} />,
              inspectorTarget
            )
          : null}
        <RoomAddAgentDialog
          open={addAgentOpen}
          onOpenChange={setAddAgentOpen}
          roomId={data.roomId}
          worktreeId={
            data.snapshot?.room.worktreeId ??
            data.rooms.find((room) => room.id === data.roomId)?.worktreeId ??
            null
          }
          worktrees={worktrees}
          target={target}
        />
        {settingsOpen ? (
          <RoomSettingsDialog
            key={data.roomId ?? 'none'}
            data={data}
            open
            onOpenChange={setSettingsOpen}
          />
        ) : null}
        <input
          ref={archiveInputRef}
          type="file"
          accept=".zip,application/zip"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0]
            if (file) {
              void importArchive(file)
            }
          }}
        />
      </main>
    </AgentSubagentProvider>
  )
}

export function roomProjectId(
  activeRepoId: string | null,
  activeWorkspaceKey: string | null
): string | null {
  const scope = parseWorkspaceKey(activeWorkspaceKey ?? '')
  return scope?.type === 'folder' ? activeWorkspaceKey : activeRepoId
}

function EmptyState({
  title,
  description
}: {
  title: string
  description: string
}): React.JSX.Element {
  return (
    <main className="flex min-h-0 flex-1 items-center justify-center bg-background p-8">
      <div className="flex max-w-sm flex-col items-center text-center">
        <div className="mb-4 rounded-xl border border-border bg-muted/40 p-3">
          <MessagesSquare className="size-6 text-muted-foreground" />
        </div>
        <h1 className="text-base font-semibold">{title}</h1>
        <p className="mb-4 mt-1 text-sm text-muted-foreground">{description}</p>
      </div>
    </main>
  )
}
