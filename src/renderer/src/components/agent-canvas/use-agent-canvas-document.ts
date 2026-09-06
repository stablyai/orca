import { useCallback, useEffect, useRef, useState } from 'react'
import type { CanvasDocument } from './agent-canvas-document'
import {
  CANVAS_STORAGE_PREFIX,
  readCanvasDocument,
  registerCanvasDocument
} from './canvas-document-access'
export { CANVAS_STORAGE_PREFIX, readCanvasDocument } from './canvas-document-access'

export function useAgentCanvasDocument(scope: string) {
  const key = CANVAS_STORAGE_PREFIX + scope
  const [initial] = useState(() => readCanvasDocument(key))
  const [document, setDocument] = useState(initial.document)
  const [error, setError] = useState(initial.error)
  const [past, setPast] = useState<CanvasDocument[]>([])
  const current = useRef(document)
  const dirty = useRef(false)
  const mounted = useRef(true)
  const blocked = initial.error !== null

  const save = useCallback(() => {
    if (!dirty.current || blocked) {
      return
    }
    try {
      localStorage.setItem(key, JSON.stringify(current.current))
      dirty.current = false
      setError(null)
    } catch {
      setError('Canvas changes could not be saved on this device. Keep this view open and retry.')
    }
  }, [blocked, key])

  useEffect(() => {
    const timer = setTimeout(save, 350)
    return () => clearTimeout(timer)
  }, [document, save])
  useEffect(() => {
    mounted.current = true
    window.addEventListener('beforeunload', save)
    return () => {
      mounted.current = false
      window.removeEventListener('beforeunload', save)
      save()
    }
  }, [save])

  const update = useCallback(
    (change: (value: CanvasDocument) => CanvasDocument, remember = true) => {
      if (blocked) {
        return
      }
      const previous = current.current
      const next = change(previous)
      if (next === previous) {
        return
      }
      if (remember) {
        setPast((history) => [...history.slice(-19), previous])
      }
      current.current = next
      dirty.current = true
      setDocument(next)
      if (!mounted.current) {
        save()
      }
    },
    [blocked, save]
  )

  const checkpoint = useCallback(() => {
    const previous = current.current
    setPast((history) => [...history.slice(-19), previous])
  }, [])

  useEffect(() => {
    if (blocked) {
      return
    }
    return registerCanvasDocument(scope, {
      read: () => current.current,
      apply: (next) => update(() => next)
    })
  }, [blocked, scope, update])

  const undo = useCallback(() => {
    const previous = past.at(-1)
    if (!previous || blocked) {
      return
    }
    setPast((history) => history.slice(0, -1))
    current.current = previous
    dirty.current = true
    setDocument(previous)
  }, [blocked, past])

  return {
    document,
    update,
    checkpoint,
    undo,
    canUndo: past.length > 0,
    error,
    readOnly: blocked,
    save
  }
}
