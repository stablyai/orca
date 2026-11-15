import { useContext, useLayoutEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import {
  closeNativeChatSubagentOnEscape,
  NATIVE_CHAT_SUBAGENT_SHEET_ATTRIBUTE
} from './native-chat-open-subagent'
import { NativeChatSubagentSheetHost } from './NativeChatSubagentSheetLayer'
import { trapNativeChatSubagentSheetTab } from './native-chat-subagent-sheet-tab'

// 80% of the pane, at least 320px; a pane under 400px tall gives the sheet all of it.
const SHEET_STYLE: React.CSSProperties = {
  height: 'max(80%, min(100%, calc((400px - 100%) * 1000)))',
  minHeight: 'min(320px, 100%)'
}

/** A subagent's view, slid up over its own chat pane; the conversation stays mounted, inert, under a scrim. */
export function NativeChatSubagentSheet({
  paneKey,
  agentId,
  titleId,
  onClose,
  children
}: {
  paneKey: string
  agentId: string
  titleId: string
  onClose: () => void
  children: React.ReactNode
}): React.JSX.Element | null {
  const host = useContext(NativeChatSubagentSheetHost)
  const sheetRef = useRef<HTMLDivElement>(null)
  const setShown = host?.setShown
  const element = host?.element ?? null
  useLayoutEffect(() => {
    if (!element) {
      return undefined
    }
    setShown?.(true)
    return () => setShown?.(false)
  }, [element, setShown])
  // Opening, or a swap that dropped focus with the view it was in, lands on the sheet itself.
  useLayoutEffect(() => {
    const sheet = sheetRef.current
    const active = document.activeElement
    if (sheet && (active === null || active === document.body || !sheet.contains(active))) {
      sheet.focus({ preventScroll: true })
    }
  }, [agentId, element])
  if (!element) {
    return null
  }
  return createPortal(
    <>
      <div
        aria-hidden
        className="absolute inset-0 z-40 bg-black/35 animate-in fade-in-0 duration-[220ms] motion-reduce:animate-none"
        onClick={onClose}
      />
      <div
        ref={sheetRef}
        {...{ [NATIVE_CHAT_SUBAGENT_SHEET_ATTRIBUTE]: '' }}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={(event) => {
          trapNativeChatSubagentSheetTab(event, event.currentTarget)
          closeNativeChatSubagentOnEscape(event, paneKey)
        }}
        style={SHEET_STYLE}
        className="@container/subagent-sheet absolute inset-x-0 bottom-0 z-40 flex max-h-full flex-col overflow-hidden rounded-t-[14px] border-t border-chat-composer-border bg-chat-sheet [--chat-pane:var(--chat-sheet)] shadow-[0_-10px_30px_rgba(0,0,0,0.25)] outline-none animate-in slide-in-from-bottom duration-[220ms] ease-[cubic-bezier(0.2,0.8,0.2,1)] motion-reduce:animate-none"
      >
        {children}
        {/* At most half the sheet, so a tall prompt scrolls inside; the rows' gutter keeps its edges on theirs. */}
        <div
          ref={host?.setPromptSlot}
          className="flex max-h-1/2 min-h-0 shrink-0 flex-col scrollbar-sleek overflow-y-auto px-4 pb-3 [scrollbar-gutter:stable_both-edges] empty:hidden"
        />
      </div>
    </>,
    element
  )
}
