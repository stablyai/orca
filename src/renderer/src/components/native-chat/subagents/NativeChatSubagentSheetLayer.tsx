import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { openNativeChatSubagent, useNativeChatOpenSubagent } from './native-chat-open-subagent'

export type NativeChatSubagentSheetHostValue = {
  paneKey: string
  element: HTMLElement | null
  /** The sheet reports itself mounted, which makes the rest of the pane inert. */
  setShown: (shown: boolean) => void
  /** Inside a mounted sheet, where the open subagent's own waiting prompt draws. */
  promptSlot: HTMLElement | null
  setPromptSlot: (element: HTMLElement | null) => void
  /** The open subagent's Stop, while it can be stopped. */
  stop?: React.ReactNode
  /** Which agent's prompt waits on the person: undefined none, null the main agent. */
  waiting?: string | null
}

/** Where a chat pane's sheet portals to, above the pane's content, and what its header offers. */
export const NativeChatSubagentSheetHost = createContext<NativeChatSubagentSheetHostValue | null>(
  null
)

/** A prompt the open subagent is waiting on draws in its sheet; any other stays where it is. */
export function NativeChatSubagentSheetPromptSlot({
  agentId,
  children
}: {
  /** The prompt's agent; undefined for the main agent. */
  agentId: string | undefined
  children: React.ReactNode
}): React.ReactNode {
  const host = useContext(NativeChatSubagentSheetHost)
  const openId = useNativeChatOpenSubagent(host?.paneKey ?? '')?.agentId
  const slot = host?.promptSlot
  return slot && agentId !== undefined && agentId === openId
    ? createPortal(children, slot)
    : children
}

/** Wraps a chat pane's content: a subagent sheet portals in above it and the content goes inert under it. */
export function NativeChatSubagentSheetLayer({
  paneKey,
  sessionKey,
  stop,
  waiting,
  children
}: Pick<NativeChatSubagentSheetHostValue, 'paneKey' | 'stop' | 'waiting'> & {
  /** Changes when the pane switches sessions, which closes the sheet. */
  sessionKey: string
  children: React.ReactNode
}): React.JSX.Element {
  const [element, setElement] = useState<HTMLDivElement | null>(null)
  const [promptSlot, setPromptSlot] = useState<HTMLElement | null>(null)
  const [shown, setShown] = useState(false)
  const host = useMemo<NativeChatSubagentSheetHostValue>(
    () => ({ paneKey, element, setShown, promptSlot, setPromptSlot, stop, waiting }),
    [element, paneKey, promptSlot, stop, waiting]
  )
  const sessionRef = useRef(sessionKey)
  useEffect(() => {
    if (sessionRef.current !== sessionKey) {
      sessionRef.current = sessionKey
      openNativeChatSubagent(paneKey, null)
    }
  }, [paneKey, sessionKey])
  return (
    <NativeChatSubagentSheetHost value={host}>
      {/* Contents keeps the pane's flex layout; inert still reaches every descendant. */}
      <div className="contents" inert={shown}>
        {children}
      </div>
      <div ref={setElement} className="contents" />
    </NativeChatSubagentSheetHost>
  )
}
