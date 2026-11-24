import { useRef } from 'react'
import type { IDisposable } from '@xterm/xterm'
import type { TerminalPaneVisibilitySnapshot } from '../viewport/pane-visibility-identity'
import type { ReplayingPanesRef } from '../snapshots/replay-guard'
import type { installTerminalLinkPointerGesture } from '../links/gestures/terminal-link-pointer-gesture'
import type { installHttpLinkClickFallback } from '../links/http/terminal-url-link-hit-testing'

// Hoisted: React Compiler memoizes hook calls inside an object literal into a run-once block.
export function useTerminalPaneLifecycleRefs() {
  const systemPrefersDarkRef = useRef(false)
  const previousVisibleForReconcileRef = useRef<TerminalPaneVisibilitySnapshot | null>(null)
  const linkProviderDisposablesRef = useRef(new Map<number, IDisposable>())
  const terminalHandleLinkDisposablesRef = useRef(new Map<number, IDisposable>())
  const linkifierClickPrimingDisposablesRef = useRef(new Map<number, IDisposable>())
  const linkPointerGesturesRef = useRef(
    new Map<number, ReturnType<typeof installTerminalLinkPointerGesture>>()
  )
  const fileLinkClickFallbackDisposablesRef = useRef(new Map<number, IDisposable>())
  const httpLinkClickFallbackDisposablesRef = useRef(
    new Map<number, ReturnType<typeof installHttpLinkClickFallback>>()
  )
  const selectionDisposablesRef = useRef(new Map<number, IDisposable>())
  const nativeCopyDisposablesRef = useRef(new Map<number, IDisposable>())
  const selectionCaptureTimersRef = useRef(new Map<number, number>())
  const osc52DisposablesRef = useRef(new Map<number, IDisposable>())
  const osc7DisposablesRef = useRef(new Map<number, IDisposable>())
  const mouseHideDisposablesRef = useRef(new Map<number, IDisposable>())
  const imeCompositionDisposablesRef = useRef(new Map<number, IDisposable>())
  const imeNativeTextForwarderDisposablesRef = useRef(new Map<number, IDisposable>())
  const queuedInitialCwdRef = useRef<string | null | undefined>(undefined)
  const restoredViewportBlankingPanesRef = useRef(new Set<number>())
  const replayingPanesRef = useRef<Map<number, number>>(
    new Map<number, number>()
  ) as ReplayingPanesRef
  return {
    systemPrefersDarkRef,
    previousVisibleForReconcileRef,
    linkProviderDisposablesRef,
    terminalHandleLinkDisposablesRef,
    linkifierClickPrimingDisposablesRef,
    linkPointerGesturesRef,
    fileLinkClickFallbackDisposablesRef,
    httpLinkClickFallbackDisposablesRef,
    selectionDisposablesRef,
    nativeCopyDisposablesRef,
    selectionCaptureTimersRef,
    osc52DisposablesRef,
    osc7DisposablesRef,
    mouseHideDisposablesRef,
    imeCompositionDisposablesRef,
    imeNativeTextForwarderDisposablesRef,
    queuedInitialCwdRef,
    restoredViewportBlankingPanesRef,
    replayingPanesRef
  }
}

export type TerminalPaneLifecycleRefs = ReturnType<typeof useTerminalPaneLifecycleRefs>
