import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { ORCA_BROWSER_BLANK_URL } from '../../../../../shared/constants'
import type { BrowserPage as BrowserPageState } from '../../../../../shared/browser-workspace-types'
import type { BrowserRecorderStreamEvent } from '../../../../../shared/browser-recorder-automation'
import { useBrowserRecorder, type BrowserRecorderHook } from '../useBrowserRecorder'
import { formatBrowserRecorderStepsAsMarkdown } from '../browser-recorder-output'
import { recorderEventPage, type BrowserRecorderStepDetail } from '../browser-recorder-types'
import type { BrowserRecorderPageContext } from '../useBrowserRecorder'

/** Maps a main-process recorder stream event onto a session log step. */
function toRecorderStepDetail(event: BrowserRecorderStreamEvent): BrowserRecorderStepDetail {
  switch (event.kind) {
    case 'action':
      return { kind: 'automation-action', action: event.action }
    case 'interaction':
      return { kind: 'interaction', interaction: event.interaction }
    case 'console':
      return { kind: 'console', entry: event.entry }
    case 'network-request':
      return { kind: 'network-request', request: event.request }
    case 'network-summary':
      return { kind: 'network-summary', summary: event.summary }
  }
}

export type BrowserPageRecorderSession = {
  recorder: BrowserRecorderHook
  recorderCopied: boolean
  recorderRecordingRef: MutableRefObject<boolean>
  recordRecorderStep: (detail: BrowserRecorderStepDetail, page: BrowserRecorderPageContext) => void
  handleToggleBrowserRecorder: () => Promise<void>
  handleCopyBrowserRecorderLog: () => void
  handleClearBrowserRecorderLog: () => void
}

/** Owns the recorder session state and its page-level wiring for one browser page. */
export function useBrowserPageRecorderSession(
  browserTab: BrowserPageState
): BrowserPageRecorderSession {
  const recorder = useBrowserRecorder(browserTab.id)
  const { recordStep: recordRecorderStep } = recorder
  const [recorderCopied, setRecorderCopied] = useState(false)
  const recorderCopyTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  // Why: recorder.recording is a state the markup/grab callbacks close over;
  // a ref keeps the latest value without recreating the callbacks on change.
  const recorderRecordingRef = useRef(recorder.recording)
  recorderRecordingRef.current = recorder.recording
  const recordFeatureInteraction = useAppStore((s) => s.recordFeatureInteraction)

  const recorderPrompt = useMemo(
    () =>
      formatBrowserRecorderStepsAsMarkdown(recorder.steps, {
        startedAt: recorder.startedAt ?? undefined
      }),
    [recorder.startedAt, recorder.steps]
  )
  // Why: the stop-click auto-copy runs 100ms later — a ref reads the latest
  // log instead of the one captured when the callback was created.
  const recorderPromptRef = useRef(recorderPrompt)
  recorderPromptRef.current = recorderPrompt

  const handleToggleBrowserRecorder = useCallback(async (): Promise<void> => {
    recordFeatureInteraction('browser-recorder')
    const nextRecording = !recorder.recording
    if (nextRecording) {
      // Why: fail-closed toggle — if main cannot attach to the page, do not
      // show a recording session that records nothing.
      const attached = await window.api.browser
        .setRecorderEnabled({
          enabled: true,
          browserPageId: browserTab.id,
          options: recorder.options
        })
        // Why: normalize IPC rejection to false so the toggle stays fail-closed.
        .catch(() => false)
      if (!attached) {
        console.warn(
          '[browser-recorder] could not attach to the page; recording not started',
          browserTab.id
        )
        return
      }
      recorder.toggle({ pageUrl: browserTab.url, pageTitle: browserTab.title })
    } else {
      void window.api.browser
        .setRecorderEnabled({
          enabled: false,
          browserPageId: browserTab.id
        })
        .catch(() => false)
      recorder.toggle({ pageUrl: browserTab.url, pageTitle: browserTab.title })
      // Why: the flow is done — auto-copy the log so the user can drop it
      // into an agent or note without an extra click.
      setTimeout(() => {
        const log = recorderPromptRef.current
        if (log) {
          void window.api.ui.writeClipboardText(log)
          setRecorderCopied(true)
          clearTimeout(recorderCopyTimerRef.current)
          recorderCopyTimerRef.current = setTimeout(() => setRecorderCopied(false), 1400)
          toast.success(
            translate(
              'auto.components.browser.pane.BrowserPane.recorderAutoCopied',
              'Recording log copied to clipboard'
            )
          )
        }
      }, 100)
    }
  }, [browserTab.id, browserTab.title, browserTab.url, recordFeatureInteraction, recorder])

  const handleCopyBrowserRecorderLog = useCallback((): void => {
    if (!recorderPrompt) {
      return
    }
    void window.api.ui.writeClipboardText(recorderPrompt)
    recordFeatureInteraction('browser-recorder')
    clearTimeout(recorderCopyTimerRef.current)
    setRecorderCopied(true)
    recorderCopyTimerRef.current = setTimeout(() => setRecorderCopied(false), 1400)
  }, [recorderPrompt, recordFeatureInteraction])

  const handleClearBrowserRecorderLog = useCallback((): void => {
    if (recorder.stepCount === 0) {
      return
    }
    clearTimeout(recorderCopyTimerRef.current)
    setRecorderCopied(false)
    recordFeatureInteraction('browser-recorder')
    recorder.clear()
  }, [recordFeatureInteraction, recorder])

  // Why: fold main-process recorder events (automation actions, manual
  // interactions, console output, network summary) into the session log; main
  // only emits while recording is on.
  useEffect(() => {
    return window.api.browser.onRecorderEvent((event) => {
      const page = recorderEventPage(event)
      if (page.browserPageId !== browserTab.id) {
        return
      }
      recordRecorderStep(toRecorderStepDetail(event), { pageUrl: page.url, pageTitle: page.title })
    })
  }, [browserTab.id, recordRecorderStep])

  // Why: recording is a per-pane session; leaving the pane must not leave the
  // main-process recorder capturing actions into the void.
  useEffect(() => {
    return () => {
      if (recorderRecordingRef.current) {
        void window.api.browser
          .setRecorderEnabled({
            enabled: false,
            browserPageId: browserTab.id
          })
          // Why: normalize IPC rejection like the stop path — guest teardown
          // can reject, and an unhandled rejection is invisible to the user.
          .catch(() => false)
      }
    }
  }, [browserTab.id])

  // Why: while recording, log every page change so the session shows where the
  // user navigated and which page each later step happened on. The baseline is
  // seeded per tab so the pre-existing URL is never logged as a navigation.
  const recorderNavBaselineRef = useRef<{ tabId: string; url: string } | null>(null)
  useEffect(() => {
    const baseline = recorderNavBaselineRef.current
    recorderNavBaselineRef.current = { tabId: browserTab.id, url: browserTab.url }
    if (!baseline || baseline.tabId !== browserTab.id) {
      return
    }
    if (baseline.url === browserTab.url) {
      return
    }
    // Why: skip navigations INTO the blank tab placeholder (redirect chains can
    // pass through about:blank); leaving blank for the first real page is a
    // legitimate step the user performed.
    if (browserTab.url === ORCA_BROWSER_BLANK_URL) {
      return
    }
    recordRecorderStep(
      { kind: 'navigation', fromUrl: baseline.url, toUrl: browserTab.url },
      { pageUrl: browserTab.url, pageTitle: browserTab.title }
    )
  }, [browserTab.id, browserTab.title, browserTab.url, recordRecorderStep])

  return {
    recorder,
    recorderCopied,
    recorderRecordingRef,
    recordRecorderStep,
    handleToggleBrowserRecorder,
    handleCopyBrowserRecorderLog,
    handleClearBrowserRecorderLog
  }
}
