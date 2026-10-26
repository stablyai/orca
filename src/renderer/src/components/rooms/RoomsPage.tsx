/**
 * Group-chat rooms list + transcript + composer.
 * Members are Orca chat sessions addressed as orca_session_id:<id>.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { JSX } from 'react'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
import { translate } from '@/i18n/i18n'
import { useAllWorktrees } from '@/store/selectors'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { BOT_AGENTS, LOCAL, ORCA_SESSION_PREFIX } from './room-types'
import { shortSessionLabel, useAgentSessionPool } from './room-session-pool'
import { useRooms } from './useRooms'
import { useRoomLog } from './useRoomLog'
import { RoomSidebar } from './RoomSidebar'
import { RoomChatHeader } from './RoomChatHeader'
import { RoomRosterBar } from './RoomRosterBar'
import { RoomTranscript } from './RoomTranscript'
import { RoomComposer } from './RoomComposer'
import { activeWorkingMembers, waitingApprovalMembers } from './room-working-members'
import { selectRoomMemberChatLines } from './room-chat-transcript-model'
import { useNow } from '@/hooks/use-now'

export default function RoomsPage(): JSX.Element {
  // Why: this memo boundary needs its own language subscription, while
  // translate() preserves Orca's pseudo-localization behavior.
  useTranslation()
  const { rooms, loading, refresh } = useRooms()
  const pool = useAgentSessionPool()
  const worktrees = useAllWorktrees()
  const worktreeNames = useMemo(
    () => new Map(worktrees.map((w) => [w.id, w.displayName])),
    [worktrees]
  )
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [directMemberId, setDirectMemberId] = useState<string | null>(null)
  const [composer, setComposer] = useState('')
  const [sending, setSending] = useState(false)
  const [membersOpen, setMembersOpen] = useState(false)
  const [seenSeqByRoom, setSeenSeqByRoom] = useState<Record<string, number>>({})
  const initializedSeqs = useRef(false)
  const selected = useMemo(() => {
    if (selectedId) {
      return rooms.find((room) => room.id === selectedId) ?? null
    }
    return rooms.find((room) => room.name === 'Orca HQ') ?? rooms[0] ?? null
  }, [rooms, selectedId])
  const directMember = selected?.members.find((m) => m.memberId === directMemberId) ?? null
  const {
    lines,
    refresh: refreshLog,
    addPendingMessage,
    discardPendingMessage
  } = useRoomLog(selected?.id ?? null)
  const directLines = useMemo(
    () => (directMember ? selectRoomMemberChatLines(lines, directMember) : lines),
    [directMember, lines]
  )
  const bottomRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [directLines.length])

  const mentionQuery = useMemo(() => {
    const m = composer.match(/@([\w\u4e00-\u9fa5]*)$/)
    return m ? m[1].toLowerCase() : null
  }, [composer])
  const mentionOptions = useMemo(() => {
    if (mentionQuery === null || !selected) {
      return []
    }
    const names = selected.members.map((mem) => mem.name)
    if (selected.adminMemberId) {
      names.push('all')
    }
    return names.filter((n) => n.toLowerCase().includes(mentionQuery)).slice(0, 8)
  }, [mentionQuery, selected])
  const applyMention = useCallback((name: string) => {
    setComposer((cur) => cur.replace(/@([\w\u4e00-\u9fa5]*)$/, `@${name} `))
  }, [])

  const sendText = useCallback(
    async (text: string, targetMemberId?: string) => {
      if (!selected || !text.trim() || sending) {
        return
      }
      const roomId = selected.id
      const trimmed = text.trim()
      const message =
        directMember && !trimmed.toLowerCase().startsWith(`@${directMember.name.toLowerCase()} `)
          ? `@${directMember.name} ${trimmed}`
          : trimmed
      const pendingKey = addPendingMessage(roomId, message, targetMemberId ?? directMember?.memberId)
      setComposer('')
      setSending(true)
      try {
        const delivered = await callRuntimeRpc<{
          seq: number
          slots: { name: string; status: string; note?: string }[]
        }>(LOCAL, 'orchestration.roomSend', {
          id: roomId,
          text: message,
          ...((targetMemberId ?? directMember?.memberId) ? { targetMemberId: targetMemberId ?? directMember?.memberId } : {})
        })
        await refreshLog()
        discardPendingMessage(pendingKey)
        for (const slot of delivered.slots.filter((slot) => slot.status === 'failed')) {
          toast.error(
            `${translate('auto.components.rooms.page.botFailed', 'Bot failed')}: ${slot.name}${
              slot.note ? ` — ${slot.note}` : ''
            }`
          )
        }
      } catch (error) {
        discardPendingMessage(pendingKey)
        setComposer(message)
        toast.error(
          `${translate('auto.components.rooms.page.sendFailed', 'Failed to send')}: ${error instanceof Error ? error.message : String(error)}`
        )
      } finally {
        setSending(false)
      }
    },
    [selected, directMember, sending, refreshLog, addPendingMessage, discardPendingMessage]
  )

  const deleteRoom = async () => {
    if (!selected) {
      return
    }
    try {
      await callRuntimeRpc(LOCAL, 'orchestration.roomDelete', { id: selected.id })
      toast.success(translate('auto.components.rooms.page.deleted', 'Room deleted'))
      setSelectedId(null)
      await refresh()
    } catch (error) {
      toast.error(
        `${translate('auto.components.rooms.page.deleteFailed', 'Failed to delete')}: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  const addMember = async (sessionId: string, isAdmin: boolean) => {
    if (!selected) {
      return
    }
    const opt = pool.find((p) => p.sessionId === sessionId)
    const agent = sessionId.split('_')[0] ?? ''
    if (!opt || !BOT_AGENTS.some((item) => item.id === agent)) {
      toast.error(
        translate('auto.components.rooms.page.unsupportedSessionAgent', 'Unknown agent type')
      )
      return
    }
    try {
      await callRuntimeRpc(LOCAL, 'orchestration.roomBotCreate', {
        id: selected.id,
        name: shortSessionLabel(opt?.label || sessionId),
        agent,
        worktree: `id:${opt.worktreeId}`,
        isAdmin
      })
      await refresh()
      toast.success(translate('auto.components.rooms.page.memberAdded', 'Member added'))
    } catch (error) {
      toast.error(
        `${translate('auto.components.rooms.page.addMemberFailed', 'Failed to add member')}: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  const removeMember = async (memberId: string) => {
    if (!selected) {
      return
    }
    try {
      await callRuntimeRpc(LOCAL, 'orchestration.roomMemberRemove', { id: selected.id, memberId })
      await refresh()
    } catch (error) {
      toast.error(
        `${translate('auto.components.rooms.page.removeMemberFailed', 'Failed to remove member')}: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  const poolAvailable = useMemo(
    () =>
      pool.filter(
        (p) => !selected?.members.some((m) => m.memberId === `${ORCA_SESSION_PREFIX}${p.sessionId}`)
      ),
    [pool, selected]
  )
  const adminName = selected?.members.find((m) => m.isAdmin)?.name ?? null
  const statusNow = useNow(30_000, Boolean(selected))
  const workingMembers = useMemo(
    () => (selected ? activeWorkingMembers(selected.members, statusNow) : []),
    [selected, statusNow]
  )
  const waitingMembers = useMemo(
    () => (selected ? waitingApprovalMembers(selected.members) : []),
    [selected]
  )
  const workingIds = useMemo(() => {
    const ids = new Set<string>()
    for (const room of rooms) {
      if (room.members.some((member) => member.status === 'working')) {
        ids.add(room.id)
      }
    }
    return ids
  }, [rooms])
  const waitingIds = useMemo(() => {
    const ids = new Set<string>()
    for (const room of rooms) {
      if (room.members.some((member) => member.status === 'waiting')) {
        ids.add(room.id)
      }
    }
    return ids
  }, [rooms])
  const retryMember = useCallback(
    (memberId: string) => {
      const member = selected?.members.find((entry) => entry.memberId === memberId)
      const lastUser = directLines.toReversed().find((line) => !line.memberId)
      if (member && lastUser) {
        void sendText(lastUser.text, member.memberId)
      }
    },
    [directLines, selected, sendText]
  )
  const selectRoom = useCallback((roomId: string) => {
    setSelectedId(roomId)
    setDirectMemberId(null)
  }, [])
  const unreadIds = useMemo(() => {
    const ids = new Set<string>()
    for (const room of rooms) {
      if ((seenSeqByRoom[room.id] ?? room.seq ?? 0) < (room.seq ?? 0)) {
        ids.add(room.id)
      }
    }
    return ids
  }, [rooms, seenSeqByRoom])

  useEffect(() => {
    if (initializedSeqs.current || rooms.length === 0) {
      return
    }
    initializedSeqs.current = true
    setSeenSeqByRoom(Object.fromEntries(rooms.map((room) => [room.id, room.seq ?? 0])))
  }, [rooms])
  useEffect(() => {
    if (!selected?.id) {
      return
    }
    setSeenSeqByRoom((current) => ({
      ...current,
      [selected.id]: Math.max(current[selected.id] ?? 0, selected.seq ?? 0)
    }))
  }, [selected?.id, selected?.seq])
  useEffect(() => {
    setDirectMemberId(null)
  }, [selected?.id])

  return (
    <div className="flex h-full min-h-0 overflow-hidden bg-background text-foreground">
      <RoomSidebar
        rooms={rooms}
        loading={loading}
        selectedId={selected?.id ?? null}
        workingIds={workingIds}
        waitingIds={waitingIds}
        unreadIds={unreadIds}
        onSelect={selectRoom}
        directMemberId={directMemberId}
        onSelectMember={setDirectMemberId}
        onRefresh={() => void refresh()}
        onCreated={() => void refresh()}
      />
      <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        {selected ? (
          <>
            <RoomChatHeader
              selected={selected}
              adminName={adminName}
              directMember={directMember}
              onExitDirect={() => setDirectMemberId(null)}
              onOpenMembers={() => setMembersOpen(true)}
              onDelete={() => void deleteRoom()}
            />
            <RoomRosterBar
              selected={selected}
              open={membersOpen}
              onOpenChange={setMembersOpen}
              poolAvailable={poolAvailable}
              worktreeNames={worktreeNames}
              onSpawned={() => {
                void refresh()
              }}
              onAddMember={(sessionId, isAdmin) => void addMember(sessionId, isAdmin)}
              onRemoveMember={(memberId) => void removeMember(memberId)}
            />
            <RoomTranscript
              selected={selected}
              lines={directLines}
              adminName={adminName}
              directMember={directMember}
              bottomRef={bottomRef}
              onQuickSend={(t) => void sendText(t)}
              onSpawnBot={() => {
                setMembersOpen(true)
              }}
              workingMembers={
                directMember
                  ? workingMembers.filter((member) => member.memberId === directMember.memberId)
                  : workingMembers
              }
              waitingMembers={
                directMember
                  ? waitingMembers.filter((member) => member.memberId === directMember.memberId)
                  : waitingMembers
              }
              onRetryMember={retryMember}
            />
            <RoomComposer
              composer={composer}
              sending={sending}
              directMemberName={directMember?.name ?? null}
              mentionOptions={mentionOptions}
              mentionQuery={mentionQuery}
              onComposerChange={setComposer}
              onApplyMention={applyMention}
              onSend={() => void sendText(composer)}
            />
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
            {translate(
              'auto.components.rooms.page.pickRoom',
              'Pick a room, or create one on the left.'
            )}
          </div>
        )}
      </main>
    </div>
  )
}
