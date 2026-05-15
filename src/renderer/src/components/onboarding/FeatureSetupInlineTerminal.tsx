import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { Loader2 } from 'lucide-react'
import TerminalPane from '@/components/terminal-pane/TerminalPane'
import { PASTE_TERMINAL_TEXT_EVENT, type PasteTerminalTextDetail } from '@/constants/terminal'
import { focusTerminalTabSurface } from '@/lib/focus-terminal-tab-surface'
import { track } from '@/lib/telemetry'
import { useAppStore } from '@/store'
import {
  onboardingFeatureSetupTelemetrySelection,
  type OnboardingFeatureSetupSelection
} from './onboarding-feature-setup'

const ONBOARDING_SETUP_TERMINAL_WORKTREE_ID = 'onboarding-setup-terminal'
const AUTO_INSERT_DELAY_MS = 700
const READY_RETRY_MS = 100
const READY_MAX_ATTEMPTS = 50

type FeatureSetupInlineTerminalProps = {
  command: string
  selection: OnboardingFeatureSetupSelection
}

export function FeatureSetupInlineTerminal({
  command,
  selection
}: FeatureSetupInlineTerminalProps): React.JSX.Element {
  const createTab = useAppStore((s) => s.createTab)
  const closeTab = useAppStore((s) => s.closeTab)
  const setActiveTabForWorktree = useAppStore((s) => s.setActiveTabForWorktree)
  const setTabCustomTitle = useAppStore((s) => s.setTabCustomTitle)
  const [cwd, setCwd] = useState<string | null>(null)
  const [tabId, setTabId] = useState<string | null>(null)
  const terminalSectionRef = useRef<HTMLElement>(null)
  const autoInsertedRef = useRef<string | null>(null)
  const terminalOpenedTrackedRef = useRef(false)
  const terminalInteractedTrackedRef = useRef(false)

  const selectionTelemetry = useMemo(
    () => onboardingFeatureSetupTelemetrySelection(selection),
    [selection]
  )

  useEffect(() => {
    if (terminalOpenedTrackedRef.current) {
      return
    }
    terminalOpenedTrackedRef.current = true
    track('onboarding_feature_setup_terminal_opened', selectionTelemetry)
  }, [selectionTelemetry])

  const trackTerminalInteraction = useCallback(
    (method: 'keyboard' | 'pointer', event?: KeyboardEvent<HTMLElement>) => {
      if (terminalInteractedTrackedRef.current) {
        return
      }
      const isMac = navigator.userAgent.includes('Mac')
      const isContinueShortcut = event?.key === 'Enter' && (isMac ? event.metaKey : event.ctrlKey)
      if (isContinueShortcut) {
        return
      }
      // Why: auto-insert focuses the terminal programmatically; only count
      // direct terminal activity, not the global continue shortcut.
      terminalInteractedTrackedRef.current = true
      track('onboarding_feature_setup_terminal_interacted', {
        ...selectionTelemetry,
        method
      })
    },
    [selectionTelemetry]
  )

  useEffect(() => {
    void window.api.app.getFloatingTerminalCwd({ path: '~' }).then(setCwd)
  }, [])

  useEffect(() => {
    const tab = createTab(ONBOARDING_SETUP_TERMINAL_WORKTREE_ID, undefined, undefined, {
      activate: false
    })
    setActiveTabForWorktree(ONBOARDING_SETUP_TERMINAL_WORKTREE_ID, tab.id)
    setTabCustomTitle(tab.id, 'Skill setup')
    setTabId(tab.id)
  }, [createTab, setActiveTabForWorktree, setTabCustomTitle])

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const prefersReducedMotion =
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches
      terminalSectionRef.current?.scrollIntoView({
        behavior: prefersReducedMotion ? 'auto' : 'smooth',
        block: 'center'
      })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [])

  const insertCommand = useCallback(() => {
    if (!tabId) {
      return
    }
    terminalSectionRef.current?.scrollIntoView({
      behavior: 'auto',
      block: 'nearest'
    })
    window.dispatchEvent(
      new CustomEvent<PasteTerminalTextDetail>(PASTE_TERMINAL_TEXT_EVENT, {
        detail: {
          tabId,
          text: command.trim()
        }
      })
    )
    focusTerminalTabSurface(tabId)
  }, [command, tabId])

  useEffect(() => {
    if (!tabId || autoInsertedRef.current === command) {
      return
    }
    let canceled = false
    let insertionTimer: number | null = null

    const waitForTerminal = (attempt: number): void => {
      if (canceled) {
        return
      }
      if (findTerminalTabElement(tabId)?.querySelector('[data-pty-id]')) {
        insertionTimer = window.setTimeout(() => {
          if (!canceled) {
            autoInsertedRef.current = command
            insertCommand()
          }
        }, AUTO_INSERT_DELAY_MS)
        return
      }
      if (attempt < READY_MAX_ATTEMPTS) {
        window.setTimeout(() => waitForTerminal(attempt + 1), READY_RETRY_MS)
      }
    }

    waitForTerminal(0)
    return () => {
      canceled = true
      if (insertionTimer !== null) {
        window.clearTimeout(insertionTimer)
      }
    }
  }, [command, insertCommand, tabId])

  return (
    <section
      ref={terminalSectionRef}
      aria-label="Skill setup command"
      className="mt-5 overflow-hidden rounded-xl border border-border bg-card"
    >
      <div className="border-b border-border px-4 py-3">
        <p className="text-xs leading-relaxed text-muted-foreground">
          Press Enter to run the command and confirm npm if asked. You can also set this up later in
          Settings.
        </p>
      </div>
      <div
        className="relative h-[280px] min-h-0 bg-background"
        onKeyDownCapture={(event) => trackTerminalInteraction('keyboard', event)}
        onPointerDownCapture={() => trackTerminalInteraction('pointer')}
      >
        {cwd && tabId ? (
          <TerminalPane
            tabId={tabId}
            worktreeId={ONBOARDING_SETUP_TERMINAL_WORKTREE_ID}
            cwd={cwd}
            isActive
            isVisible
            onPtyExit={() => closeTab(tabId)}
            onCloseTab={() => closeTab(tabId)}
          />
        ) : (
          <div className="flex h-full items-center justify-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Starting terminal...
          </div>
        )}
      </div>
    </section>
  )
}

function findTerminalTabElement(tabId: string): HTMLElement | null {
  for (const element of document.querySelectorAll<HTMLElement>('[data-terminal-tab-id]')) {
    if (element.dataset.terminalTabId === tabId) {
      return element
    }
  }
  return null
}
