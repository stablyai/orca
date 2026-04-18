import { useEffect, useRef, useCallback } from 'react'
import { useAppStore } from '@/store'
import { useAudioCapture } from '@/hooks/use-audio-capture'
import { toast } from 'sonner'
import { DictationIndicator } from './DictationIndicator'
import { dispatchClearModifierHints } from '@/hooks/useModifierHint'

const IS_MAC = navigator.userAgent.includes('Mac')

export function DictationController() {
  const dictationState = useAppStore((s) => s.dictationState)
  const setDictationState = useAppStore((s) => s.setDictationState)
  const setPartialTranscript = useAppStore((s) => s.setPartialTranscript)
  const settings = useAppStore((s) => s.settings)
  const { start: startCapture, stop: stopCapture } = useAudioCapture()

  const dictationStateRef = useRef(dictationState)
  dictationStateRef.current = dictationState

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
            // TODO: navigate to voice settings
          }
        }
      })
      return
    }

    if (!settings?.voice?.enabled) {
      toast('Voice dictation is disabled. Enable it in Settings > Voice.')
      return
    }

    dispatchClearModifierHints()
    setDictationState('starting')

    try {
      await window.api.speech.startDictation(modelId)
      await startCapture()
      setDictationState('listening')
    } catch (err) {
      setDictationState('error')
      const message = String(err)
      if (message.includes('Permission') || message.includes('NotAllowed')) {
        toast.error('Microphone access denied. Grant access in system settings, then restart Orca.')
      } else if (message.includes('not ready')) {
        toast('Speech model not ready. Download it in Settings > Voice.')
      } else {
        toast.error(`Dictation failed: ${message}`)
      }
      stopCapture()
      setDictationState('idle')
    }
  }, [settings, setDictationState, startCapture, stopCapture])

  const stopDictation = useCallback(async () => {
    if (dictationStateRef.current !== 'listening' && dictationStateRef.current !== 'starting') {
      return
    }
    setDictationState('stopping')
    stopCapture()
    try {
      await window.api.speech.stopDictation()
    } catch {
      // Swallow stop errors — the worker may already be torn down.
    }
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
      if (dictationStateRef.current === 'listening' || dictationStateRef.current === 'starting') {
        void stopDictation()
      } else {
        void startDictation()
      }
    }

    const cleanup = window.api.ui.onDictationKeyDown(handleKeyDown)
    return cleanup
  }, [settings?.voice?.dictationMode, startDictation, stopDictation])

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
      if (mod && e.code === 'KeyE' && !e.shiftKey && !e.altKey) {
        e.preventDefault()
        e.stopPropagation()
        if (dictationStateRef.current === 'idle') {
          void startDictation()
        }
      }
    }

    const handleKeyUp = (e: KeyboardEvent): void => {
      if (dictationStateRef.current === 'idle' || dictationStateRef.current === 'stopping') {
        return
      }
      if (e.code === 'KeyE' || e.key === 'Meta' || e.key === 'Control') {
        void stopDictation()
      }
    }

    window.addEventListener('keydown', handleKeyDown, true)
    window.addEventListener('keyup', handleKeyUp, true)
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true)
      window.removeEventListener('keyup', handleKeyUp, true)
    }
  }, [settings?.voice?.dictationMode, startDictation, stopDictation])

  useEffect(() => {
    const cleanupPartial = window.api.speech.onPartialTranscript((text) => {
      setPartialTranscript(text)
    })

    const cleanupFinal = window.api.speech.onFinalTranscript((text) => {
      setPartialTranscript('')
      insertText(text)
    })

    const cleanupError = window.api.speech.onError((error) => {
      toast.error(`Speech error: ${error}`)
      stopCapture()
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

function insertText(text: string): void {
  const activeElement = document.activeElement

  if (!activeElement) {
    return
  }

  // Why: xterm.js uses a hidden textarea for keyboard input. When it has
  // focus, we write directly to the PTY via the terminal's input mechanism
  // rather than inserting into the textarea (which xterm ignores).
  if (activeElement.classList.contains('xterm-helper-textarea')) {
    document.dispatchEvent(new CustomEvent('dictation:insertText', { detail: text }))
    return
  }

  if (activeElement instanceof HTMLInputElement || activeElement instanceof HTMLTextAreaElement) {
    const start = activeElement.selectionStart ?? activeElement.value.length
    const end = activeElement.selectionEnd ?? start
    activeElement.setRangeText(text, start, end, 'end')
    activeElement.dispatchEvent(new Event('input', { bubbles: true }))
    return
  }

  if (activeElement instanceof HTMLElement && activeElement.isContentEditable) {
    const selection = window.getSelection()
    if (selection && selection.rangeCount > 0) {
      const range = selection.getRangeAt(0)
      range.deleteContents()
      range.insertNode(document.createTextNode(text))
      range.collapse(false)
    }
    return
  }

  document.dispatchEvent(new CustomEvent('dictation:insertText', { detail: text }))
}
