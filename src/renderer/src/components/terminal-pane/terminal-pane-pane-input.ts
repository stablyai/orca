import type { IDisposable } from '@xterm/xterm'
import type { ManagedPane, PaneManager } from '@/lib/pane-manager/pane-manager'
import type { UseTerminalPaneLifecycleDeps } from './terminal-pane-lifecycle-types'
import {
  armTerminalImePendingCandidateKeyRelease,
  clearTerminalImePendingCandidateKeyRelease,
  createTerminalImePendingCandidateKeyReleases,
  shouldApplyTerminalImePendingCandidateKeyRelease
} from './terminal-ime-candidate-key-release-guard'
import { installTerminalImeCompositionTracker } from './terminal-ime-composition-tracker'
import { installTerminalImeComposerPlaceholderMask } from './terminal-ime-composer-placeholder-mask'
import { installTerminalImeLinuxCandidateState } from './terminal-ime-linux-candidate-state'
import { installTerminalImeNativeTextForwarder } from './terminal-ime-native-text-forwarder'
import { installTerminalIosHangulPreedit } from './terminal-ios-hangul-preedit'
import { createTerminalIosHangulPreeditRenderer } from './terminal-ios-hangul-preedit-overlay'
import { isCurrentPlatformIosWeb } from '@/lib/ios-web-platform'
import { resolveTerminalJisYenInput } from './terminal-jis-yen-input'
import {
  isNonLatinControlChordKeyup,
  resolveNonLatinControlChordInput
} from './terminal-non-latin-control-chord'
import {
  shouldBypassXtermKeyboardEvent,
  shouldHandleTerminalInterruptKeyboardEvent,
  shouldPreventDefaultTerminalImeCandidateKey,
  shouldSuppressTerminalImeKeyboardEvent,
  shouldSuppressTerminalInterruptKeyup,
  shouldSuppressTerminalModifierKeyboardEvent,
  TERMINAL_INTERRUPT_INPUT
} from './xterm-bypass-policy'
import { markTerminalPinnedViewport } from '@/lib/pane-manager/terminal-scroll-intent'
import { syncTerminalScrollIntentSoon } from '@/lib/pane-manager/terminal-scroll-intent-settle'
import { resetTerminalKeyboardProtocolAfterInterrupt } from './terminal-pane-lifecycle-primitives'

type PaneInputContext = {
  pane: ManagedPane
  managerRef: React.RefObject<PaneManager | null>
  paneKittyKeyboardModesRef: UseTerminalPaneLifecycleDeps['paneKittyKeyboardModesRef']
  settingsRef: React.RefObject<Record<string, unknown> | null | undefined>
  imeCompositionDisposablesRef: React.RefObject<Map<number, IDisposable>>
  imeNativeTextForwarderDisposablesRef: React.RefObject<Map<number, IDisposable>>
}

/** Installs platform keyboard, IME, and scroll-intent handling for one pane. */
export function installTerminalPaneInputHandling(context: PaneInputContext): void {
  const {
    pane,
    managerRef,
    paneKittyKeyboardModesRef,
    settingsRef,
    imeCompositionDisposablesRef,
    imeNativeTextForwarderDisposablesRef
  } = context
  let pendingTerminalInterruptKeyup = false
  let claimedNonLatinControlChordCode: string | null = null
  const pendingTerminalImeCandidateKeyReleases = createTerminalImePendingCandidateKeyReleases()
  const isMac = navigator.userAgent.includes('Mac')
  // Android/ChromeOS UAs also contain "Linux"; scope the candidate-key policy to desktop Linux.
  const isLinux =
    !isMac && navigator.userAgent.includes('Linux') && !/Android|CrOS/.test(navigator.userAgent)
  const isIosWeb = isCurrentPlatformIosWeb()
  const linuxImeCandidateState = isLinux
    ? installTerminalImeLinuxCandidateState(pane.terminal.element)
    : null
  const imeCompositionTracker = installTerminalImeCompositionTracker(pane.terminal.element)
  const imeComposerPlaceholderMask = installTerminalImeComposerPlaceholderMask(pane.terminal)
  const iosHangulPreedit = isIosWeb
    ? installTerminalIosHangulPreedit({
        terminalElement: pane.terminal.element,
        isCompositionActive: () => imeCompositionTracker.isActive(),
        isScreenReaderMode: () => pane.terminal.options.screenReaderMode === true,
        sendInput: (data) => pane.terminal.input(data),
        renderPreedit: createTerminalIosHangulPreeditRenderer(pane.terminal)
      })
    : null
  imeCompositionDisposablesRef.current.set(pane.id, {
    dispose: () => {
      imeComposerPlaceholderMask.dispose()
      imeCompositionTracker.dispose()
      linuxImeCandidateState?.dispose()
      iosHangulPreedit?.dispose()
    }
  })
  const imeNativeTextForwarder =
    isMac && !isIosWeb
      ? installTerminalImeNativeTextForwarder({
          terminalElement: pane.terminal.element,
          isComposing: () => imeCompositionTracker.isActive(),
          sendInput: (data) => pane.terminal.input(data),
          getKittyKeyboardFlags: () => paneKittyKeyboardModesRef.current.get(pane.id)?.flags ?? 0
        })
      : { claimKeyEvent: () => false, dispose: () => undefined }
  imeNativeTextForwarderDisposablesRef.current.set(pane.id, imeNativeTextForwarder)

  pane.terminal.attachCustomKeyEventHandler((event) => {
    const linuxCandidateClassification = linuxImeCandidateState?.classifyKeyboardEvent(event) ?? {
      candidateDigitGuardActive: false
    }
    const observeLinuxCandidateEvent = (): void => {
      linuxImeCandidateState?.observeKeyboardEvent(event, linuxCandidateClassification)
    }
    const now = Date.now()
    const pendingCandidateReleaseGuardActive = shouldApplyTerminalImePendingCandidateKeyRelease(
      event,
      pendingTerminalImeCandidateKeyReleases,
      now
    )
    const imeKeyboardOptions = {
      compositionActive: imeCompositionTracker.isActive(),
      candidateKeyGuardActive:
        imeCompositionTracker.isCandidateKeyGuardActive() || pendingCandidateReleaseGuardActive,
      pendingCandidateKeyReleaseActive: pendingCandidateReleaseGuardActive,
      linuxOrphanCandidateDigitGuardActive: linuxCandidateClassification.candidateDigitGuardActive,
      hangulPreedit: imeCompositionTracker.isHangulPreedit(),
      isMac,
      isLinux
    }
    if (shouldSuppressTerminalImeKeyboardEvent(event, imeKeyboardOptions)) {
      clearTerminalImePendingCandidateKeyRelease(pendingTerminalImeCandidateKeyReleases, event)
      if (shouldPreventDefaultTerminalImeCandidateKey(event, imeKeyboardOptions)) {
        event.preventDefault()
        armTerminalImePendingCandidateKeyRelease(pendingTerminalImeCandidateKeyReleases, event, now)
      }
      observeLinuxCandidateEvent()
      return false
    }
    clearTerminalImePendingCandidateKeyRelease(pendingTerminalImeCandidateKeyReleases, event)
    if (pendingTerminalInterruptKeyup && shouldSuppressTerminalInterruptKeyup(event)) {
      pendingTerminalInterruptKeyup = false
      observeLinuxCandidateEvent()
      return false
    }
    if (
      shouldHandleTerminalInterruptKeyboardEvent(event, {
        isMac,
        hasSelection: pane.terminal.hasSelection()
      })
    ) {
      if (event.type === 'keydown') {
        pendingTerminalInterruptKeyup = true
        pane.terminal.input(TERMINAL_INTERRUPT_INPUT)
        resetTerminalKeyboardProtocolAfterInterrupt(pane.terminal)
      } else {
        pendingTerminalInterruptKeyup = false
      }
      observeLinuxCandidateEvent()
      return false
    }
    if (isNonLatinControlChordKeyup(event, claimedNonLatinControlChordCode)) {
      claimedNonLatinControlChordCode = null
      observeLinuxCandidateEvent()
      return false
    }
    const nonLatinControlChord = resolveNonLatinControlChordInput(event)
    if (nonLatinControlChord) {
      claimedNonLatinControlChordCode = event.code
      pane.terminal.input(nonLatinControlChord)
      observeLinuxCandidateEvent()
      return false
    }
    if (shouldSuppressTerminalModifierKeyboardEvent(event)) {
      observeLinuxCandidateEvent()
      return false
    }
    const jisYenInput = resolveTerminalJisYenInput(event, {
      enabled: settingsRef.current?.terminalJISYenToBackslash === true,
      isMac
    })
    if (jisYenInput) {
      if (jisYenInput.type === 'input') {
        pane.terminal.input(jisYenInput.data)
      }
      observeLinuxCandidateEvent()
      return false
    }
    if (event.type === 'keydown') {
      const shouldSyncCurrentTerminal = (): boolean =>
        managerRef.current?.getPanes().some((candidate) => candidate.terminal === pane.terminal) ===
        true
      if (event.key === 'PageUp' || event.key === 'Home') {
        markTerminalPinnedViewport(pane.terminal)
        syncTerminalScrollIntentSoon(pane.terminal, {
          preservePinnedAtBottom: true,
          shouldSync: shouldSyncCurrentTerminal
        })
      } else if (event.key === 'PageDown' || event.key === 'End') {
        syncTerminalScrollIntentSoon(pane.terminal, { shouldSync: shouldSyncCurrentTerminal })
      }
    }
    if (imeNativeTextForwarder.claimKeyEvent(event)) {
      observeLinuxCandidateEvent()
      return false
    }
    const shouldBypass = shouldBypassXtermKeyboardEvent(event, {
      isMac,
      isIosWeb,
      hasSelection: pane.terminal.hasSelection(),
      kittyKeyboardFlags: paneKittyKeyboardModesRef.current.get(pane.id)?.flags ?? 0
    })
    observeLinuxCandidateEvent()
    return !shouldBypass
  })
}

export type { PaneInputContext }
