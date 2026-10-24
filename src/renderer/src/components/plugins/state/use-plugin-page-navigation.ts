import { pluginHostVersion } from '../../../../../shared/plugins/plugin-host-version'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

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
  open: (pluginKey: string) => void
  back: () => void
  /** Goes back only if this plugin's page is the one open; stable across renders. */
  leave: (pluginKey: string) => void
}

/**
 * Which plugin's page is open, and the way back: the back link, Alt+← or ⌘[ on Mac. Going back
 * returns focus to that plugin's name in the list. Esc stays with Settings.
 */
export function usePluginPageNavigation(onBack?: () => void): PluginPageNavigation {
  const [openKey, setOpenKey] = useState<string | null>(null)
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

  const openKeyRef = useRef(openKey)
  useLayoutEffect(() => {
    openKeyRef.current = openKey
  })
  const back = useCallback(() => {
    onBack?.()
    setReturnKey(openKeyRef.current)
    setOpenKey(null)
  }, [onBack])
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

  const leave = useCallback((pluginKey: string) => {
    if (openKeyRef.current === pluginKey) {
      setOpenKey(null)
    }
  }, [])
  return { openKey, open: setOpenKey, back, leave }
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
