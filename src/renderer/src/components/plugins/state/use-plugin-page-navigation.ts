import { pluginHostVersion } from '../../../../../shared/plugins/installation/plugin-host-version'
import { useCallback, useEffect, useRef, useState } from 'react'

function isBackShortcut(event: KeyboardEvent): boolean {
  const mac = navigator.userAgent.includes('Mac')
  return (
    (event.altKey && !event.metaKey && !event.ctrlKey && event.key === 'ArrowLeft') ||
    (mac && event.metaKey && !event.altKey && event.key === '[')
  )
}

// Why: Alt+← moves the caret in a field, and a dialog over the page owns its own keys.
function belongsToFieldOrDialog(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false
  }
  return (
    target.isContentEditable ||
    target.closest('input, textarea, select, [role="dialog"], [role="alertdialog"]') !== null
  )
}

export type PluginPageNavigation = {
  openKey: string | null
  previousKey: string | null
  open: (pluginKey: string, options?: { replace?: boolean }) => void
  back: () => void
  toCatalog: () => void
  /** Removes a deleted plugin from page history; stable across renders. */
  leave: (pluginKey: string) => void
}

/**
 * Which plugin's page is open, and the way back: the back link, Alt+← or ⌘[ on Mac. Going back
 * traverses detail pages, then returns focus to the first plugin's name in the list.
 */
export function usePluginPageNavigation(
  onNavigate?: (pluginKey: string | null) => void
): PluginPageNavigation {
  const [history, setHistory] = useState<string[]>([])
  const historyRef = useRef(history)
  const openKey = history.at(-1) ?? null
  const [returnKey, setReturnKey] = useState<string | null>(null)

  useEffect(() => {
    if (openKey || !returnKey) {
      return
    }
    const name = document.querySelector<HTMLButtonElement>(
      `[data-plugin-key="${CSS.escape(returnKey)}"] [data-plugin-row-name]`
    )
    name?.focus()
    setReturnKey(null)
  }, [openKey, returnKey])

  const open = useCallback<PluginPageNavigation['open']>(
    (pluginKey, options) => {
      if (historyRef.current.at(-1) === pluginKey) {
        return
      }
      onNavigate?.(pluginKey)
      historyRef.current = [
        ...(options?.replace ? historyRef.current.slice(0, -1) : historyRef.current),
        pluginKey
      ]
      setHistory(historyRef.current)
    },
    [onNavigate]
  )
  const back = useCallback(() => {
    const previous = historyRef.current
    historyRef.current = previous.slice(0, -1)
    onNavigate?.(historyRef.current.at(-1) ?? null)
    if (historyRef.current.length === 0) {
      setReturnKey(previous[0] ?? null)
    }
    setHistory(historyRef.current)
  }, [onNavigate])
  const toCatalog = useCallback(() => {
    onNavigate?.(null)
    setReturnKey(historyRef.current[0] ?? null)
    historyRef.current = []
    setHistory([])
  }, [onNavigate])
  useEffect(() => {
    if (!openKey) {
      return
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (
        isBackShortcut(event) &&
        !event.defaultPrevented &&
        !belongsToFieldOrDialog(event.target)
      ) {
        event.preventDefault()
        back()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [openKey, back])

  const leave = useCallback(
    (pluginKey: string) => {
      const previousKey = historyRef.current.at(-1)
      historyRef.current = historyRef.current.filter((key) => key !== pluginKey)
      if (previousKey !== historyRef.current.at(-1)) {
        onNavigate?.(historyRef.current.at(-1) ?? null)
      }
      setHistory(historyRef.current)
    },
    [onNavigate]
  )
  return { openKey, previousKey: history.at(-2) ?? null, open, back, toCatalog, leave }
}

/** The version plugins are gated against, for "Needs Orca X" checks; null until known. Why not
 *  the raw app version: main gates on pluginHostVersion, and a development build's package version
 *  lags the fields it already reads, so the two must agree. */
export function useOrcaVersion(): string | null {
  const [version, setVersion] = useState<string | null>(null)
  useEffect(() => {
    let stale = false
    void window.api.updater
      .getVersion()
      .then((value) => {
        if (!stale) {
          setVersion(pluginHostVersion(value))
        }
      })
      .catch(() => undefined)
    return () => {
      stale = true
    }
  }, [])
  return version
}
