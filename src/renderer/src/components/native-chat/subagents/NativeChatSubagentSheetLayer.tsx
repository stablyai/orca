import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import { createPortal } from 'react-dom'
import {
  closeNativeChatSubagentOnEscape,
  openNativeChatSubagent,
  useNativeChatOpenSubagent
} from './native-chat-open-subagent'
import { NativeChatInSubagentSheet } from './native-chat-subagent-sheet-context'
import { trapNativeChatSubagentSheetTab } from './native-chat-subagent-sheet-tab'

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
  const slot = host?.promptSlot ?? null
  const inSheet = slot !== null && agentId !== undefined && agentId === openId
  // One portal box for the card's whole life: moving the box, not the card, keeps a half-typed answer.
  const [box] = useState(() => {
    const element = document.createElement('div')
    element.className = 'contents'
    return element
  })
  const anchorRef = useRef<HTMLDivElement | null>(null)
  // Placed as the anchor mounts, before the card's own layout effects ask for focus.
  const placeAtAnchor = useCallback(
    (anchor: HTMLDivElement | null) => {
      anchorRef.current = anchor
      if (anchor && box.parentNode === null) {
        anchor.appendChild(box)
      }
    },
    [box]
  )
  useLayoutEffect(() => {
    const target = inSheet ? slot : anchorRef.current
    if (!target || box.parentNode === target) {
      return
    }
    const sheet = box.parentElement?.closest<HTMLElement>('[role="dialog"]')
    const hadFocus = box.contains(document.activeElement)
    target.appendChild(box)
    // Leaving a sheet that stays open (Esc up a level) takes the card's focus with it; the sheet keeps it.
    if (hadFocus && sheet?.isConnected && !sheet.contains(box)) {
      sheet.focus({ preventScroll: true })
    }
  }, [box, inSheet, slot])
  useLayoutEffect(() => () => box.remove(), [box])
  const paneKey = host?.paneKey
  return (
    <>
      <div ref={placeAtAnchor} className="contents" />
      {createPortal(
        <NativeChatInSubagentSheet value={inSheet}>
          <div
            className="contents"
            onKeyDown={(event) => {
              const sheet = slot?.closest<HTMLElement>('[role="dialog"]')
              if (inSheet && sheet) {
                trapNativeChatSubagentSheetTab(event, sheet)
              }
            }}
            onKeyDownCapture={(event) => {
              if (
                !inSheet ||
                paneKey === undefined ||
                event.key !== 'Escape' ||
                event.nativeEvent.isComposing
              ) {
                return
              }
              // A card's own Esc cancels or folds its prompt; in the sheet Esc only goes up or closes,
              // from its answer field too, which keeps a half-typed answer.
              event.stopPropagation()
              closeNativeChatSubagentOnEscape(event, paneKey, true)
            }}
          >
            {children}
          </div>
        </NativeChatInSubagentSheet>,
        box
      )}
    </>
  )
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
