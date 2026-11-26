import { NativeChatWaitingAgentMailRowsContext } from '../queue/NativeChatWaitingAgentMailActions'
import { slackPeopleOf } from '../../../../../shared/connectors/slack-mention-tokens'
import { useCallback, useContext, useEffect, useId, useMemo, useRef, useState } from 'react'
import {
  projectionBesideStreamedText,
  rowsBesideStreamedText
} from '../../../../../shared/agent-session/view/structured-agent-session-streamed-text-rows'
import { NativeChatMessageList } from '../NativeChatMessageList'
import { NativeChatSideChatForkPointContext } from '../messages/actions/native-chat-fork-context'
import { NativeChatSlackPeopleContext } from '../native-chat-markdown-mentions'
import { focusNativeChatPromptCard } from '../prompts/use-native-chat-prompt-card-focus'
import { NativeChatToolRunWindowProvider } from '../tools/runs/native-chat-tool-run-window-context'
import { NativeChatGalleryCoveredFocusContext } from '../media/images/gallery/native-chat-image-gallery-context'
import type { NativeChatFind } from '../viewport/find/use-native-chat-find'
import {
  closeNativeChatSubagentToPrompt,
  NATIVE_CHAT_SUBAGENT_SHEET_ATTRIBUTE,
  noteNativeChatSubagentParent,
  openNativeChatSubagent,
  openNativeChatSubagentToPrompt,
  takeNativeChatSubagentOpener,
  useNativeChatOpenSubagent,
  type NativeChatSubagentView
} from './native-chat-open-subagent'
import { NativeChatSubagentSheet } from './NativeChatSubagentSheet'
import { NativeChatInSubagentSheet } from './native-chat-subagent-sheet-context'
import { NativeChatSubagentSheetHost } from './NativeChatSubagentSheetLayer'

/** Where focus goes once the sheet closes: what opened it, else its roster entry or strip row, else the composer. */
function returnFocusTarget(
  main: HTMLElement,
  agentId: string,
  opener: Element | 'prompt' | undefined
): HTMLElement | null {
  if (opener instanceof HTMLElement && opener.isConnected && opener.closest('[inert]') === null) {
    return opener
  }
  const id = CSS.escape(agentId)
  const root = main.closest('[data-native-chat-root]')
  return (
    main.querySelector<HTMLElement>(`[data-native-chat-subagent-entry="${id}"] button`) ??
    root?.querySelector<HTMLElement>(`[data-native-chat-agent-row="${id}"]`) ??
    root?.querySelector<HTMLElement>('[data-native-chat-prompt-editor]') ??
    null
  )
}

/** `current` while shown; covered, what it drew on covering until `beside` (its rows besides streamed
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

/** The conversation stays mounted and in place under an open subagent's sheet, so closing keeps the reader's place. */
export function NativeChatSubagentTranscripts({
  paneKey,
  find,
  ...props
}: React.ComponentProps<typeof NativeChatMessageList> & {
  /** The chat's status pane key, which also names it to the sidebar's subagent rows. */
  paneKey: string
  find: Pick<NativeChatFind, 'isOpen' | 'query'>
}): React.JSX.Element {
  const host = useContext(NativeChatSubagentSheetHost)
  const stop = host?.stop
  // A terminal chat's waiting prompt is always its main agent's.
  const waiting =
    host?.waiting !== undefined ? host.waiting : props.awaitingInput ? null : undefined
  const openId = useNativeChatOpenSubagent(paneKey)?.agentId ?? null
  const open = useCallback(
    (agentId: string | null) => openNativeChatSubagent(paneKey, agentId),
    [paneKey]
  )
  const main = useMemo<NativeChatSubagentView>(() => ({ agentId: null, open }), [open])
  const titleId = useId()
  const showWaiting = useCallback(
    (agentId: string | null) =>
      agentId === null
        ? closeNativeChatSubagentToPrompt(paneKey)
        : openNativeChatSubagentToPrompt(paneKey, agentId),
    [paneKey]
  )
  const shown = useMemo<NativeChatSubagentView | null>(
    () =>
      openId === null
        ? null
        : {
            agentId: openId,
            open,
            noteParent: (parentId) => noteNativeChatSubagentParent(paneKey, openId, parentId),
            sheet: { titleId, stop, waiting, showWaiting }
          },
    [open, openId, paneKey, showWaiting, stop, titleId, waiting]
  )
  const isVisible = props.isVisible ?? true
  // Paused under the sheet, the conversation keeps the rows and messages it last drew until they
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
  const sheetView = useCallback(
    () =>
      mainRef.current
        ?.closest('[data-native-chat-root]')
        ?.querySelector<HTMLElement>(`[${NATIVE_CHAT_SUBAGENT_SHEET_ATTRIBUTE}]`) ?? null,
    []
  )
  const previousIdRef = useRef<string | null>(null)
  useEffect(() => {
    const previousId = previousIdRef.current
    previousIdRef.current = openId
    if (previousId === null || openId !== null) {
      return undefined
    }
    const opener = takeNativeChatSubagentOpener(paneKey)
    // The conversation leaves inert a commit later; only focus the closing sheet dropped is handed back.
    const frame = requestAnimationFrame(() => {
      const main = mainRef.current
      const active = document.activeElement
      // A scrim click leaves focus on the pane root, which owns no control either.
      if (
        !main ||
        (active !== null && active !== document.body && !active.matches('[data-native-chat-root]'))
      ) {
        return
      }
      const root = main.closest('[data-native-chat-root]')
      if (opener === 'prompt' && root && focusNativeChatPromptCard(root, null)) {
        return
      }
      returnFocusTarget(main, previousId, opener)?.focus({ preventScroll: true })
    })
    return () => cancelAnimationFrame(frame)
  }, [openId, paneKey])
  return (
    <NativeChatToolRunWindowProvider isVisible={isVisible} find={find}>
      <div ref={mainRef} className="relative flex min-h-0 flex-1 flex-col">
        {/* Paused under the sheet, as when hidden: its scroll stays where the reader left it. */}
        <NativeChatSlackPeopleContext value={slackPeople}>
          {/* A sheet opened over an open image viewer takes the focus the viewer gives up. */}
          <NativeChatGalleryCoveredFocusContext value={sheetView}>
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
      {shown && openId !== null ? (
        <NativeChatSubagentSheet
          paneKey={paneKey}
          agentId={openId}
          titleId={titleId}
          onClose={() => open(null)}
        >
          {/* `/btw` forks from the conversation, never from a subagent's rows. */}
          <NativeChatSideChatForkPointContext value={undefined}>
            <NativeChatInSubagentSheet value>
              {/* The conversation's waiting mail draws in the conversation, not in a subagent's rows. */}
              <NativeChatWaitingAgentMailRowsContext value={null}>
                <NativeChatMessageList
                  key={openId}
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
              </NativeChatWaitingAgentMailRowsContext>
            </NativeChatInSubagentSheet>
          </NativeChatSideChatForkPointContext>
        </NativeChatSubagentSheet>
      ) : null}
    </NativeChatToolRunWindowProvider>
  )
}
