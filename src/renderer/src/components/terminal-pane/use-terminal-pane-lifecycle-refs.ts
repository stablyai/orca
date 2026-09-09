import { useRef } from 'react'
import type { IDisposable } from '@xterm/xterm'
import type { TerminalPaneVisibilitySnapshot } from './terminal-pane-lifecycle-primitives'
import type { ReplayingPanesRef } from './replay-guard'
import type { installTerminalLinkPointerGesture } from './terminal-link-pointer-gesture'
import type { installHttpLinkClickFallback } from './terminal-url-link-hit-testing'

/** Mutable registries owned by one mounted pane surface. */
export function useTerminalPaneLifecycleRefs() {
  return {
    systemPrefersDarkRef: useRef(false),
    previousVisibleForReconcileRef: useRef<TerminalPaneVisibilitySnapshot | null>(null),
    linkProviderDisposablesRef: useRef(new Map<number, IDisposable>()),
    terminalHandleLinkDisposablesRef: useRef(new Map<number, IDisposable>()),
    linkifierClickPrimingDisposablesRef: useRef(new Map<number, IDisposable>()),
    linkPointerGesturesRef: useRef(
      new Map<number, ReturnType<typeof installTerminalLinkPointerGesture>>()
    ),
    fileLinkClickFallbackDisposablesRef: useRef(new Map<number, IDisposable>()),
    httpLinkClickFallbackDisposablesRef: useRef(
      new Map<number, ReturnType<typeof installHttpLinkClickFallback>>()
    ),
    selectionDisposablesRef: useRef(new Map<number, IDisposable>()),
    selectionCaptureTimersRef: useRef(new Map<number, number>()),
    osc52DisposablesRef: useRef(new Map<number, IDisposable>()),
    osc7DisposablesRef: useRef(new Map<number, IDisposable>()),
    mouseHideDisposablesRef: useRef(new Map<number, IDisposable>()),
    imeCompositionDisposablesRef: useRef(new Map<number, IDisposable>()),
    imeNativeTextForwarderDisposablesRef: useRef(new Map<number, IDisposable>()),
    queuedInitialCwdRef: useRef<string | null | undefined>(undefined),
    restoredViewportBlankingPanesRef: useRef(new Set<number>()),
    replayingPanesRef: useRef<Map<number, number>>(new Map<number, number>()) as ReplayingPanesRef
  }
}

export type TerminalPaneLifecycleRefs = ReturnType<typeof useTerminalPaneLifecycleRefs>
