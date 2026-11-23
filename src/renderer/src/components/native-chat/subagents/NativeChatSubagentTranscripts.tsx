import { slackPeopleOf } from '../../../../../shared/connectors/slack-mention-tokens'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { cn } from '@/lib/class-names'
import {
  projectionBesideStreamedText,
  rowsBesideStreamedText
} from '../../../../../shared/agent-session/view/structured-agent-session-streamed-text-rows'
import { NativeChatMessageList } from '../NativeChatMessageList'
import { NativeChatSideChatForkPointContext } from '../messages/actions/native-chat-fork-context'
import { NativeChatSlackPeopleContext } from '../native-chat-markdown-mentions'
import { NativeChatToolRunWindowProvider } from '../tools/runs/native-chat-tool-run-window-context'
import { NativeChatGalleryCoveredFocusContext } from '../media/images/gallery/native-chat-image-gallery-context'
import type { NativeChatFind } from '../viewport/find/use-native-chat-find'
import {
  noteNativeChatSubagentParent,
  openNativeChatSubagent,
  useNativeChatOpenSubagent,
  type NativeChatSubagentView
} from './native-chat-open-subagent'

/** What took the reader into a subagent, to hand focus back to: its roster entry, its strip row, else the composer. */
function returnFocusTarget(main: HTMLElement, agentId: string): HTMLElement | null {
  const id = CSS.escape(agentId)
  const root = main.closest('[data-native-chat-root]')
  return (
    main.querySelector<HTMLElement>(`[data-native-chat-subagent-entry="${id}"] button`) ??
    root?.querySelector<HTMLElement>(`[data-native-chat-agent-row="${id}"]`) ??
    root?.querySelector<HTMLElement>('[data-native-chat-prompt-editor]') ??
    null
  )
}

/** `current` while shown; hidden, what it drew on hiding until `beside` (its rows besides streamed
 *  text) changes, then `current`, which never shows less text than was drawn. */
function useHeldWhileHidden<T extends readonly object[]>(
  current: T | undefined,
  hidden: boolean,
  beside: (rows: T) => T
): T | undefined {
  const [held, setHeld] = useState<{ base: T; drawn: T } | null>(null)
  if (!hidden || current === undefined) {
    if (held !== null) {
      setHeld(null)
    }
    return current
  }
  const base = beside(current)
  if (held?.base !== base) {
    setHeld({ base, drawn: current })
    return current
  }
  return held.drawn
}

/** The conversation stays mounted, hidden, under an open subagent's view, so going back keeps the reader's place. */
export function NativeChatSubagentTranscripts({
  paneKey,
  find,
  ...props
}: React.ComponentProps<typeof NativeChatMessageList> & {
  /** The chat's status pane key, which also names it to the sidebar's subagent rows. */
  paneKey: string
  find: Pick<NativeChatFind, 'isOpen' | 'query'>
}): React.JSX.Element {
  const openId = useNativeChatOpenSubagent(paneKey)?.agentId ?? null
  const open = useCallback(
    (agentId: string | null) => openNativeChatSubagent(paneKey, agentId),
    [paneKey]
  )
  const main = useMemo<NativeChatSubagentView>(() => ({ agentId: null, open }), [open])
  const shown = useMemo<NativeChatSubagentView | null>(
    () =>
      openId === null
        ? null
        : {
            agentId: openId,
            open,
            noteParent: (parentId) => noteNativeChatSubagentParent(paneKey, openId, parentId)
          },
    [open, openId, paneKey]
  )
  const isVisible = props.isVisible ?? true
  // Hidden behind a subagent, the conversation keeps the rows and messages it last drew until they
  // change besides streamed text, so it projects nothing each live window and never rewinds text.
  const mainItems = useHeldWhileHidden(props.journalItems, shown !== null, rowsBesideStreamedText)
  const mainMessages = useHeldWhileHidden(
    props.session.messages,
    shown !== null,
    projectionBesideStreamedText
  )!
  const mainSession = useMemo(
    () =>
      mainMessages === props.session.messages
        ? props.session
        : { ...props.session, messages: mainMessages },
    [mainMessages, props.session]
  )
  const slackPeople = useMemo(() => slackPeopleOf(mainMessages), [mainMessages])

  const mainRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<HTMLDivElement>(null)
  const shownView = useCallback(() => viewRef.current, [])
  const shownId = shown?.agentId ?? null
  const previousIdRef = useRef<string | null>(null)
  useEffect(() => {
    const previousId = previousIdRef.current
    previousIdRef.current = shownId
    // Only focus a switch dropped (the view or control that had it unmounted); never take it from elsewhere.
    const active = document.activeElement
    const dropped =
      active === null || active === document.body || mainRef.current?.contains(active) === true
    if (!dropped || previousId === shownId) {
      return
    }
    if (shownId !== null) {
      viewRef.current?.focus({ preventScroll: true })
      return
    }
    // The composer the view replaced mounts in this commit; its editor attaches a frame later.
    const frame = requestAnimationFrame(() => {
      const main = mainRef.current
      if (main && previousId !== null && document.activeElement === document.body) {
        returnFocusTarget(main, previousId)?.focus({ preventScroll: true })
      }
    })
    return () => cancelAnimationFrame(frame)
  }, [shownId])
  return (
    <NativeChatToolRunWindowProvider isVisible={isVisible} find={find}>
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          ref={mainRef}
          className={cn('flex min-h-0 flex-1 flex-col', shown && 'invisible')}
          inert={shown !== null}
        >
          <NativeChatSlackPeopleContext value={slackPeople}>
            {/* A view opened over an open image viewer takes the focus the viewer gives up. */}
            <NativeChatGalleryCoveredFocusContext value={shownView}>
              <NativeChatMessageList
                {...props}
                session={mainSession}
                journalItems={mainItems}
                isVisible={isVisible && shown === null}
                subagentView={main}
              />
            </NativeChatGalleryCoveredFocusContext>
          </NativeChatSlackPeopleContext>
        </div>
        {shown ? (
          <div
            ref={viewRef}
            tabIndex={-1}
            className="absolute inset-0 flex flex-col focus:outline-none"
          >
            {/* `/btw` forks from the conversation, never from a subagent's rows. */}
            <NativeChatSideChatForkPointContext value={undefined}>
              <NativeChatMessageList
                key={shown.agentId}
                session={props.session}
                journalItems={props.journalItems}
                journalSubmissions={props.journalSubmissions}
                journalLatestTurn={props.journalLatestTurn}
                subagentRoster={props.subagentRoster}
                subagentView={shown}
                isVisible={isVisible}
                isWorking={false}
                expandSignal={props.expandSignal}
                structuredAttachments={props.structuredAttachments}
                runtimeContext={props.runtimeContext}
              />
            </NativeChatSideChatForkPointContext>
          </div>
        ) : null}
      </div>
    </NativeChatToolRunWindowProvider>
  )
}
