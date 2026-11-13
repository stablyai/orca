import { useCallback, useEffect, useMemo, useRef } from 'react'
import { cn } from '@/lib/class-names'
import { NativeChatMessageList } from '../NativeChatMessageList'
import { NativeChatSideChatForkPointContext } from '../messages/actions/native-chat-fork-context'
import { NativeChatToolRunWindowProvider } from '../tools/runs/native-chat-tool-run-window-context'
import type { NativeChatFind } from '../viewport/find/use-native-chat-find'
import {
  openNativeChatSubagent,
  useNativeChatOpenSubagent,
  type NativeChatSubagentView
} from './native-chat-open-subagent'

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
  const openId = useNativeChatOpenSubagent(paneKey)
  const open = useCallback(
    (agentId: string | null) => openNativeChatSubagent(paneKey, agentId),
    [paneKey]
  )
  const main = useMemo<NativeChatSubagentView>(() => ({ agentId: null, open }), [open])
  const shown = useMemo<NativeChatSubagentView | null>(
    () => (openId === null ? null : { agentId: openId, open }),
    [open, openId]
  )
  const isVisible = props.isVisible ?? true
  const mainRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<HTMLDivElement>(null)
  const shownId = shown?.agentId ?? null
  useEffect(() => {
    // Focus the hidden conversation dropped stays in the pane, so Esc can bring it back.
    const active = document.activeElement
    if (shownId !== null && (active === document.body || mainRef.current?.contains(active))) {
      viewRef.current?.focus({ preventScroll: true })
    }
  }, [shownId])
  return (
    <NativeChatToolRunWindowProvider isVisible={isVisible} find={find}>
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          ref={mainRef}
          className={cn('flex min-h-0 flex-1 flex-col', shown && 'invisible')}
          inert={shown !== null}
        >
          <NativeChatMessageList
            {...props}
            isVisible={isVisible && shown === null}
            subagentView={main}
          />
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
