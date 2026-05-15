import { useEffect, useRef, useCallback } from 'react'
import { useAppStore } from '@/store'
import { useAudioCapture } from '@/hooks/use-audio-capture'
import { toast } from 'sonner'
import { DictationIndicator } from './DictationIndicator'

const IS_MAC = navigator.userAgent.includes('Mac')

type DictationInsertionTarget =
  | { kind: 'terminal'; tabId: string; paneId: number }
  | { kind: 'text'; element: HTMLInputElement | HTMLTextAreaElement }
  | { kind: 'contentEditable'; element: HTMLElement }

// Why: splits compound identifiers into space-separated lowercase words
// so hotwords match natural speech (e.g., "DictationController" → "dictation controller").
function splitIdentifier(name: string): string | undefined {
  // PascalCase / camelCase → split on uppercase boundaries
  // kebab-case / snake_case → split on - or _
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[-_]+/g, ' ')
    .toLowerCase()
    .trim()
  return words.includes(' ') ? words : undefined
}

function collectHotwords(): string[] {
  const state = useAppStore.getState()
  const seen = new Set<string>()
  const hotwords: string[] = []

  const addWord = (word: string): void => {
    if (word && !seen.has(word)) {
      seen.add(word)
      hotwords.push(word)
    }
  }

  const addFileHotwords = (relativePath: string): void => {
    const basename = relativePath.split('/').pop() ?? ''
    addWord(basename)
    const dotIdx = basename.lastIndexOf('.')
    const nameOnly = dotIdx > 0 ? basename.slice(0, dotIdx) : basename
    if (dotIdx > 0) {
      addWord(nameOnly)
    }
    const spoken = splitIdentifier(nameOnly)
    if (spoken) {
      addWord(spoken)
    }
  }

  for (const file of state.openFiles) {
    if (file.relativePath) {
      addFileHotwords(file.relativePath)
    }
  }

  const worktreeId = state.activeWorktreeId
  if (worktreeId) {
    const closed = state.recentlyClosedEditorTabsByWorktree[worktreeId] ?? []
    for (const snap of closed) {
      if (snap.relativePath) {
        addFileHotwords(snap.relativePath)
      }
    }
  }

  return hotwords.slice(0, 50)
}

export function DictationController() {
  const dictationState = useAppStore((s) => s.dictationState)
  const setDictationState = useAppStore((s) => s.setDictationState)
  const setPartialTranscript = useAppStore((s) => s.setPartialTranscript)
  const settings = useAppStore((s) => s.settings)
  const { start: startCapture, stop: stopCapture } = useAudioCapture()

  const dictationStateRef = useRef(dictationState)
  dictationStateRef.current = dictationState
  const dictationRunRef = useRef(0)
  const holdGestureActiveRef = useRef(false)
  const insertionTargetRef = useRef<DictationInsertionTarget | null>(null)

  const startDictation = useCallback(async () => {
    if (dictationStateRef.current !== 'idle') {
      return
    }

    const modelId = settings?.voice?.sttModel
    if (!modelId) {
      toast('No speech model selected. Download one in Settings > Voice.', {
        action: {
          label: 'Open Settings',
          onClick: () => {
            useAppStore.getState().openSettingsTarget({ pane: 'voice', repoId: null })
            useAppStore.getState().openSettingsPage()
          }
        }
      })
      return
    }

    if (!settings?.voice?.enabled) {
      toast('Voice dictation is disabled. Enable it in Settings > Voice.')
      return
    }

    const runId = dictationRunRef.current + 1
    dictationRunRef.current = runId
    insertionTargetRef.current = captureInsertionTarget()
    dictationStateRef.current = 'starting'
    setDictationState('starting')

    const hotwords = collectHotwords()
    let speechStarted = false

    try {
      await window.api.speech.startDictation(modelId, hotwords.length > 0 ? hotwords : undefined)
      speechStarted = true
      if (dictationRunRef.current !== runId) {
        insertionTargetRef.current = null
        await window.api.speech.stopDictation().catch(() => undefined)
        return
      }
      await startCapture()
      if (dictationRunRef.current !== runId) {
        insertionTargetRef.current = null
        stopCapture()
        await window.api.speech.stopDictation().catch(() => undefined)
        return
      }
      dictationStateRef.current = 'listening'
      setDictationState('listening')
    } catch (err) {
      if (dictationRunRef.current !== runId) {
        return
      }
      if (speechStarted) {
        await window.api.speech.stopDictation().catch(() => undefined)
      }
      dictationStateRef.current = 'error'
      setDictationState('error')
      const message = String(err)
      if (message.includes('Permission') || message.includes('NotAllowed')) {
        toast.error('Microphone access denied. Grant access in system settings, then restart Orca.')
      } else if (message.includes('not ready')) {
        toast('Speech model not ready. Download it in Settings > Voice.')
      } else if (message.includes('Unknown model')) {
        toast('Selected model is no longer available. Please choose another in Settings > Voice.', {
          action: {
            label: 'Open Settings',
            onClick: () => {
              useAppStore.getState().openSettingsTarget({ pane: 'voice', repoId: null })
              useAppStore.getState().openSettingsPage()
            }
          }
        })
      } else {
        toast.error(`Dictation failed: ${message}`)
      }
      stopCapture()
      dictationStateRef.current = 'idle'
      setDictationState('idle')
    }
  }, [settings, setDictationState, startCapture, stopCapture])

  const stopDictation = useCallback(async () => {
    if (dictationStateRef.current !== 'listening' && dictationStateRef.current !== 'starting') {
      return
    }
    dictationRunRef.current += 1
    dictationStateRef.current = 'stopping'
    setDictationState('stopping')
    stopCapture()
    try {
      await window.api.speech.stopDictation()
    } catch {
      // Swallow stop errors — the worker may already be torn down.
    }
    dictationStateRef.current = 'idle'
    setDictationState('idle')
    setPartialTranscript('')
  }, [setDictationState, setPartialTranscript, stopCapture])

  // Toggle mode: use IPC from main process (before-input-event intercepts
  // the keyDown so Cmd+E doesn't reach xterm or trigger system shortcuts).
  useEffect(() => {
    const mode = settings?.voice?.dictationMode ?? 'toggle'
    if (mode !== 'toggle') {
      return
    }

    const handleKeyDown = (): void => {
      if (
        !settings?.voice?.enabled ||
        !settings.voice.sttModel ||
        dictationStateRef.current === 'stopping'
      ) {
        return
      }
      if (dictationStateRef.current === 'listening' || dictationStateRef.current === 'starting') {
        void stopDictation()
      } else {
        void startDictation()
      }
    }

    const cleanup = window.api.ui.onDictationKeyDown(handleKeyDown)
    return cleanup
  }, [
    settings?.voice?.dictationMode,
    settings?.voice?.enabled,
    settings?.voice?.sttModel,
    startDictation,
    stopDictation
  ])

  // Why: hold mode uses renderer-side DOM events instead of the IPC path
  // (before-input-event). When before-input-event calls preventDefault()
  // on the keyDown, Electron suppresses ALL subsequent DOM events for that
  // key combo — including the keyUp we need to detect release. By handling
  // Cmd+E entirely in the renderer, both keydown and keyup fire normally.
  // On macOS, Cmd+E doesn't produce a terminal control character (unlike
  // Ctrl+E on Linux), so letting it through to xterm is harmless.
  useEffect(() => {
    const mode = settings?.voice?.dictationMode ?? 'toggle'
    if (mode !== 'hold') {
      return
    }

    const handleKeyDown = (e: KeyboardEvent): void => {
      const mod = IS_MAC ? e.metaKey : e.ctrlKey
      if (mod && (e.key.toLowerCase() === 'e' || e.code === 'KeyE') && !e.shiftKey && !e.altKey) {
        if (!settings?.voice?.enabled || !settings.voice.sttModel) {
          return
        }
        e.preventDefault()
        e.stopPropagation()
        holdGestureActiveRef.current = true
        if (dictationStateRef.current === 'idle') {
          void startDictation()
        }
      }
    }

    const handleKeyUp = (e: KeyboardEvent): void => {
      if (!holdGestureActiveRef.current) {
        return
      }
      if (dictationStateRef.current === 'idle' || dictationStateRef.current === 'stopping') {
        holdGestureActiveRef.current = false
        return
      }
      if (
        e.key.toLowerCase() === 'e' ||
        e.code === 'KeyE' ||
        e.key === 'Meta' ||
        e.key === 'Control'
      ) {
        holdGestureActiveRef.current = false
        void stopDictation()
      }
    }

    const handleBlur = (): void => {
      if (!holdGestureActiveRef.current) {
        return
      }
      holdGestureActiveRef.current = false
      if (dictationStateRef.current !== 'idle' && dictationStateRef.current !== 'stopping') {
        insertionTargetRef.current = null
        void stopDictation()
      }
    }

    const handleVisibilityChange = (): void => {
      if (document.visibilityState !== 'visible') {
        handleBlur()
      }
    }

    window.addEventListener('keydown', handleKeyDown, true)
    window.addEventListener('keyup', handleKeyUp, true)
    window.addEventListener('blur', handleBlur)
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      handleBlur()
      window.removeEventListener('keydown', handleKeyDown, true)
      window.removeEventListener('keyup', handleKeyUp, true)
      window.removeEventListener('blur', handleBlur)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [
    settings?.voice?.dictationMode,
    settings?.voice?.enabled,
    settings?.voice?.sttModel,
    startDictation,
    stopDictation
  ])

  useEffect(() => {
    const cleanupPartial = window.api.speech.onPartialTranscript((text) => {
      setPartialTranscript(text)
    })

    const cleanupFinal = window.api.speech.onFinalTranscript((text) => {
      setPartialTranscript('')
      const target = insertionTargetRef.current
      insertionTargetRef.current = null
      if (target) {
        insertText(text, target)
      }
    })

    const cleanupError = window.api.speech.onError((error) => {
      toast.error(`Speech error: ${error}`)
      stopCapture()
      insertionTargetRef.current = null
      dictationStateRef.current = 'idle'
      setDictationState('idle')
      setPartialTranscript('')
    })

    return () => {
      cleanupPartial()
      cleanupFinal()
      cleanupError()
    }
  }, [setPartialTranscript, setDictationState, stopCapture])

  return <DictationIndicator />
}

function captureInsertionTarget(): DictationInsertionTarget | null {
  const activeElement = document.activeElement

  if (!activeElement) {
    return null
  }

  if (activeElement.classList.contains('xterm-helper-textarea')) {
    const paneElement = activeElement.closest('.pane[data-pane-id]') as HTMLElement | null
    const tabElement = activeElement.closest('[data-terminal-tab-id]') as HTMLElement | null
    const paneId = Number(paneElement?.dataset.paneId)
    const tabId = tabElement?.dataset.terminalTabId
    if (tabId && Number.isFinite(paneId)) {
      return { kind: 'terminal', tabId, paneId }
    }
    return null
  }

  if (activeElement instanceof HTMLInputElement || activeElement instanceof HTMLTextAreaElement) {
    return { kind: 'text', element: activeElement }
  }

  if (activeElement instanceof HTMLElement && activeElement.isContentEditable) {
    return { kind: 'contentEditable', element: activeElement }
  }

  return null
}

function insertText(text: string, target: DictationInsertionTarget): void {
  if (target.kind === 'terminal') {
    document.dispatchEvent(
      new CustomEvent('dictation:insertText', {
        detail: { text, tabId: target.tabId, paneId: target.paneId }
      })
    )
    return
  }

  if (target.kind === 'text') {
    const element = target.element
    if (!element.isConnected) {
      return
    }
    const start = element.selectionStart ?? element.value.length
    const end = element.selectionEnd ?? start
    element.setRangeText(text, start, end, 'end')
    element.dispatchEvent(new Event('input', { bubbles: true }))
    return
  }

  if (target.kind === 'contentEditable') {
    const element = target.element
    if (!element.isConnected || !element.contains(document.activeElement)) {
      return
    }
    const editorElement = findClosestEditorElement(element) ?? element
    editorElement.dispatchEvent(
      new InputEvent('beforeinput', {
        bubbles: true,
        cancelable: true,
        inputType: 'insertText',
        data: text
      })
    )
    if (!document.execCommand('insertText', false, text)) {
      const selection = window.getSelection()
      if (selection && selection.rangeCount > 0) {
        const range = selection.getRangeAt(0)
        range.deleteContents()
        const textNode = document.createTextNode(text)
        range.insertNode(textNode)
        range.setStartAfter(textNode)
        range.collapse(true)
        selection.removeAllRanges()
        selection.addRange(range)
      }
      editorElement.dispatchEvent(
        new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text })
      )
    }
  }
}
function findClosestEditorElement(element: HTMLElement): HTMLElement | null {
  return element.closest('.ProseMirror, [contenteditable="true"]')
}
