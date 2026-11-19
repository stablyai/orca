import { folderWorkspaceKey } from '../../../../shared/workspace/identity/workspace-scope'
import { botTarget, callBotRpc } from '@/lib/bot-hosts'
import { botGroupReplyDraft } from '../../../../shared/bots/bot-group-mentions'
import { BotGroupTranscriptOwner, useBotGroupFileContexts } from './BotGroupTranscriptOwner'
import { translate } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import { createNonSecureContextUuid as createBrowserUuid } from '../../../../shared/identifiers/non-secure-context-uuid'
import { Button } from '@/components/ui/button'
import { toast } from 'sonner'
import { useBots } from '@/lib/bot-catalog'
import { useBotGroups } from '@/lib/bot-group-list'
import { useBotGroupTranscript } from './use-bot-group-transcript'
import { useBotGroupRoomRead } from './use-bot-group-room-read'
import {
  botGroupRoom,
  findBotGroupRoom,
  type BotGroupMessage,
  type BotGroupTurn as Turn
} from '../../../../shared/bots/bot-group'
import { NativeChatComposer } from '../native-chat/composer/NativeChatComposer'
import { useBotGroupComposerRoom } from './use-bot-group-composer-room'
import { useBotTranscriptFollow } from './use-bot-transcript-follow'
import { NativeChatMentionNamesContext } from '../native-chat/native-chat-markdown-mentions'
import { BotGroupPeerRequestLine } from './BotGroupPeerRequestLine'
import { NativeChatTranscriptColumn } from '../native-chat/NativeChatTranscriptColumn'
import { NativeChatTranscriptViewport } from '../native-chat/NativeChatTranscriptViewport'
import { useNativeChatSurface } from '../native-chat/use-native-chat-surface'
import { NativeChatSurface, NativeChatSurfaceFindBar } from '../native-chat/NativeChatSurface'
import { useBotGroupLinkContextFor, type BotGroupRoomLinks } from './use-bot-group-room-links'
import { MessageRow } from '../native-chat/messages/rows/NativeChatMessageRow'
import { BotGroupSessionReader, type BotGroupSession } from './BotGroupSessionReader'
import { BotGroupTurn } from './BotGroupTurn'
import { BotGroupTranscriptRows, useBotGroupTranscriptRows } from './bot-group-transcript-rows'
import type { NativeChatMessage } from '../../../../shared/native-chat/native-chat-types'
import { BotGroupApprovalDock } from './BotGroupApprovalDock'
import {
  readNativeChatDraftCache,
  writeNativeChatDraftCache
} from '../native-chat/drafts/native-chat-draft-views'
import type { NativeChatStructuredComposerTransport } from '../native-chat/composer/submit/native-chat-structured-composer-transport'
import type { NativeChatComposerHandle } from '../native-chat/composer/native-chat-composer-types'

const EMPTY_MESSAGES: BotGroupMessage[] = []
const NO_OPTIONS: NativeChatStructuredComposerTransport['optionsSurface'] = {
  getSnapshot: () => [],
  subscribe: () => () => {},
  setOption: async () => ({ snapshot: [] }),
  invokeAction: async () => ({ snapshot: [] })
}

export function BotGroupChat({
  roomId,
  tabId,
  isVisible,
  isFocusedGroup
}: {
  /** The room tab's entity: the group's id, or one of its threads'. */
  roomId: string
  tabId: string
  isVisible: boolean
  isFocusedGroup: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const groups = useBotGroups()
  const place = findBotGroupRoom(groups, roomId)
  const threadId = place?.threadId
  const found = place ? botGroupRoom(place.group, threadId) : undefined
  // A thread's tab takes its name once the host names it from the first post.
  const threadTitle = place?.group.threads?.find((thread) => thread.id === threadId)?.title
  useEffect(() => {
    if (threadTitle) {
      useAppStore.getState().setTabLabel(tabId, threadTitle)
    }
  }, [tabId, threadTitle])
  const bots = useBots()

  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [sessions, setSessions] = useState<ReadonlyMap<string, BotGroupSession>>(() => new Map())
  const report = useCallback(
    (sessionId: string, session: BotGroupSession | null) =>
      setSessions((current) => {
        const next = new Map(current)
        if (session) {
          next.set(sessionId, session)
        } else {
          next.delete(sessionId)
        }
        return next
      }),
    []
  )
  const { data, apply, loadEarlier } = useBotGroupTranscript(
    place?.group,
    threadId,
    isVisible,
    setError
  )
  const group = data?.group ?? found
  const fileContexts = useBotGroupFileContexts(bots, group, tabId)
  const roomContext = (group && fileContexts.get(group.id)) ?? null
  useBotGroupRoomRead(group?.folderWorkspaceId, isVisible)
  const messages = data?.messages ?? EMPTY_MESSAGES
  const readers = useMemo(() => {
    if (!group) {
      return []
    }
    const bySession = new Map<
      string,
      Pick<Turn, 'sessionId' | 'agent'> & { operationIds: string[] }
    >()
    for (const member of group.members) {
      const bot = bots.find((bot) => bot.id === member.botId && bot.hostId === group.hostId)
      if (bot) {
        bySession.set(member.sessionId, {
          sessionId: member.sessionId,
          agent: bot.agent,
          operationIds: []
        })
      }
    }
    for (const message of messages) {
      for (const turn of message.turns) {
        if (!turn.revoked) {
          bySession.set(turn.sessionId, {
            sessionId: turn.sessionId,
            agent: turn.agent,
            operationIds: [...(bySession.get(turn.sessionId)?.operationIds ?? []), turn.operationId]
          })
        }
      }
    }
    return [...bySession.values()]
  }, [group, bots, messages])
  const { room, mentionNames, recipientId } = useBotGroupComposerRoom(
    `bot-group:${roomId}`,
    group,
    bots,
    (group) => apply({ kind: 'group', group: botGroupRoom(group, threadId) })
  )
  const chosenId = group?.members.find((member) => member.botId === recipientId)?.sessionId
  const chosen = chosenId ? sessions.get(chosenId) : undefined
  const composerRef = useRef<NativeChatComposerHandle>(null)
  const working =
    group?.members.some((member) => sessions.get(member.sessionId)?.isWorking) ?? false
  const [rows] = useState(() => new BotGroupTranscriptRows())
  const ownerRows = useMemo(
    () =>
      new Map(
        messages.flatMap((message): [string, NativeChatMessage][] =>
          message.author.kind === 'owner'
            ? [
                [
                  message.id,
                  {
                    id: message.id,
                    role: 'user',
                    blocks: [{ type: 'text', text: message.text }],
                    timestamp: message.createdAt,
                    source: 'transcript'
                  }
                ]
              ]
            : []
        )
      ),
    [messages]
  )
  const ownerRowList = useMemo(() => [...ownerRows.values()], [ownerRows])
  useBotGroupTranscriptRows(rows, 'room', ownerRowList)
  const follow = useBotTranscriptFollow({
    messageCopyText: rows.messageCopyText,
    itemCount: messages.reduce((count, message) => count + 1 + message.turns.length, 0),
    isWorking: working,
    isVisible
  })
  const roomLinkContext = roomContext?.fileLinkContext ?? null
  const linkContextFor = useBotGroupLinkContextFor(fileContexts, roomLinkContext)
  const surface = useNativeChatSurface({
    tabId,
    sessionId: `bot-group:${roomId}`,
    isVisible,
    isFocusedGroup,
    composerRef,
    transcriptRef: follow.transcriptRef,
    fileLinkContext: roomLinkContext,
    composerReady: Boolean(group),
    conversationShown: messages.length > 0,
    menu: {
      showTerminalPaneActions: false,
      fileLinkContext: linkContextFor
    },
    sessionHistory: 'workspace'
  })
  const { onLinkClick } = surface
  const roomLinks = useMemo<BotGroupRoomLinks>(
    () => ({ onLinkClick, request: surface.requestLinkActions, rootRef: surface.rootRef }),
    [onLinkClick, surface.requestLinkActions, surface.rootRef]
  )
  const stop = useCallback(
    (botId?: string) => {
      if (!group) {
        return
      }
      void callBotRpc<{ results: { ok: boolean; refusal?: { message: string } }[] }>(
        group,
        'bots.groups.stop',
        { groupId: group.id, botId, threadId }
      )
        .then(({ results }) => {
          for (const result of results) {
            if (!result.ok) {
              toast.error(
                result.refusal?.message ??
                  translate('bots.groups.stopCouldNotBeConfirmed', 'Stop could not be confirmed.')
              )
            }
          }
        })
        .catch((error: unknown) => toast.error(String(error)))
    },
    [group, threadId]
  )
  const reply = useCallback(
    (botId: string) => {
      if (!group) {
        return
      }
      const scope = `bot-group:${roomId}`
      writeNativeChatDraftCache(
        scope,
        botGroupReplyDraft(botId, readNativeChatDraftCache(scope), group, bots)
      )
      composerRef.current?.focus()
    },
    [roomId, group, bots]
  )

  const transport: NativeChatStructuredComposerTransport = {
    runtime: 'local',
    sessionId: `bot-group:${roomId}`,
    runtimeEnvironmentId: null,
    capturePresentation: chosen?.capturePresentation ?? (() => () => true),
    acceptsImages: false,
    worktreeId: group && folderWorkspaceKey(group.folderWorkspaceId),
    optionsSurface: chosen?.optionSurface ?? NO_OPTIONS,
    optionSnapshot: chosen?.optionSnapshot ?? [],
    sendOut: sending,
    send: async (text, attachments) => {
      if (!group || sending) {
        return false
      }
      if (attachments.length) {
        setError('Group messages currently support text only.')
        return false
      }
      setSending(true)
      try {
        const { message } = await callBotRpc<{ message: BotGroupMessage }>(
          group,
          'bots.groups.send',
          {
            groupId: group.id,
            threadId,
            revision: group.revision,
            messageId: createBrowserUuid(),
            text
          }
        )
        apply({ kind: 'sent', message })
        follow.jumpToLatest()
        setError(null)
        return true
      } catch (error) {
        setError(error instanceof Error ? error.message : String(error))
        return false
      } finally {
        setSending(false)
      }
    },
    dispatchCommand: async (text) =>
      text.startsWith('/')
        ? {
            handled: true,
            accepted: false,
            error: t(
              'bots.groups.useEachBotSNativeSessionForCommands',
              'Use each bot’s native session for commands.'
            )
          }
        : { handled: false, accepted: false, error: null },
    onError: setError
  }
  return (
    <NativeChatSurface surface={surface} working={working} data-bot-group={group?.id}>
      {group
        ? readers.map((turn) => (
            <BotGroupSessionReader
              key={turn.sessionId}
              target={botTarget(group)}
              turn={turn}
              visible={isVisible}
              report={report}
            />
          ))
        : null}
      <NativeChatMentionNamesContext.Provider value={mentionNames}>
        <NativeChatTranscriptViewport
          scrollRef={follow.scrollRef}
          scrollerProps={follow.scrollerProps}
          forwardedGesture={follow.forwardedGesture}
          showJump={follow.showJump}
          onJump={follow.jumpToLatest}
          overlays={<NativeChatSurfaceFindBar surface={surface} isVisible={isVisible} />}
        >
          <BotGroupTranscriptOwner
            context={roomContext}
            sessionId={null}
            tabId={tabId}
            isVisible={isVisible}
          >
            <NativeChatTranscriptColumn ref={follow.contentRef} className="space-y-6 py-6">
              {data?.hasEarlier ? (
                <Button variant="ghost" size="sm" onClick={loadEarlier}>
                  {t('bots.groups.loadEarlierMessages', 'Load earlier messages')}
                </Button>
              ) : null}
              {!data ? (
                <p className="text-sm text-chat-foreground-faint">
                  {t('bots.groups.loadingGroup', 'Loading group…')}
                </p>
              ) : messages.length === 0 ? (
                <div className="py-12 text-center">
                  <h2 className="text-sm font-medium text-chat-foreground">{group?.name}</h2>
                  <p className="mt-2 text-sm text-chat-foreground-faint">
                    {t(
                      'bots.groups.startAConversationWithThisGroupMentionBots',
                      'Start a conversation with this group. Mention bots with @Name or @everyone.'
                    )}
                  </p>
                </div>
              ) : (
                messages.map((message) => (
                  <div key={message.id} className="space-y-5">
                    {ownerRows.has(message.id) ? (
                      <MessageRow
                        message={ownerRows.get(message.id)!}
                        expandSignal={false}
                        onScrollMessageToTop={follow.scrollMessageToTop}
                      />
                    ) : (
                      <BotGroupPeerRequestLine message={message} />
                    )}
                    {message.turns.map((turn) => (
                      <BotGroupTurn
                        key={turn.operationId}
                        hostId={data.group.hostId}
                        turn={turn}
                        tabId={tabId}
                        isVisible={isVisible}
                        files={fileContexts.get(turn.botId) ?? null}
                        roomLinks={roomLinks}
                        roomRows={rows}
                        session={sessions.get(turn.sessionId)}
                        onStop={stop}
                        onReply={reply}
                        scrollMessageToTop={follow.scrollMessageToTop}
                      />
                    ))}
                  </div>
                ))
              )}
            </NativeChatTranscriptColumn>
          </BotGroupTranscriptOwner>
        </NativeChatTranscriptViewport>
      </NativeChatMentionNamesContext.Provider>
      {group ? <BotGroupApprovalDock group={group} sessions={sessions} /> : null}
      <NativeChatComposer
        ref={composerRef}
        terminalTabId={tabId}
        paneKey={`bot-group:${roomId}`}
        draftScopeKey={`bot-group:${roomId}`}
        targetPtyId={null}
        agent={readers.find((reader) => reader.sessionId === chosenId)?.agent ?? 'claude'}
        structuredTransport={transport}
        room={room}
        isWorking={working}
        canSend={Boolean(group)}
        onStop={() => stop()}
        notices={error ? [{ key: 'bot-group-error', kind: 'error', text: error }] : []}
      />
    </NativeChatSurface>
  )
}
