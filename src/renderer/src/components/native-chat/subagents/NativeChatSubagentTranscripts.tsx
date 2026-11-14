import { useCallback, useContext, useEffect, useId, useMemo, useRef } from 'react'
import { NativeChatMessageList } from '../NativeChatMessageList'
import { NativeChatSideChatForkPointContext } from '../messages/actions/native-chat-fork-context'
import { focusNativeChatPromptCard } from '../prompts/use-native-chat-prompt-card-focus'
import { NativeChatToolRunWindowProvider } from '../tools/runs/native-chat-tool-run-window-context'
import type { NativeChatFind } from '../viewport/find/use-native-chat-find'
import {
  closeNativeChatSubagentToPrompt,
  noteNativeChatSubagentParent,
  openNativeChatSubagent,
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
      agentId === null ? closeNativeChatSubagentToPrompt(paneKey) : open(agentId),
    [open, paneKey]
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
  const mainRef = useRef<HTMLDivElement>(null)
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
        <NativeChatMessageList
          {...props}
          isVisible={isVisible && shown === null}
          subagentView={main}
        />
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
            </NativeChatInSubagentSheet>
          </NativeChatSideChatForkPointContext>
        </NativeChatSubagentSheet>
      ) : null}
    </NativeChatToolRunWindowProvider>
  )
}
