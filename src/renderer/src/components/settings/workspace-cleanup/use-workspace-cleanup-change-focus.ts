import { useEffect, useRef } from 'react'

export function useWorkspaceCleanupChangeFocus(scopeKey: string) {
  const last = useRef<HTMLElement | null>(null)
  const origin = useRef<HTMLElement | null>(null)
  const label = useRef<string | null>(null)
  useEffect(() => {
    last.current = null
    origin.current = null
    label.current = null
  }, [scopeKey])
  return {
    remember: (element: HTMLElement) => {
      if (element.hasAttribute('aria-label')) {
        last.current = element
      }
    },
    capture: () => {
      const focused = document.activeElement
      origin.current =
        focused instanceof HTMLElement && focused.hasAttribute('aria-label')
          ? focused
          : last.current
      label.current = origin.current?.getAttribute('aria-label') ?? null
    },
    restore: () => {
      const target = origin.current?.isConnected
        ? origin.current
        : label.current
          ? document.querySelector<HTMLElement>(`[aria-label="${CSS.escape(label.current)}"]`)
          : null
      target?.focus()
      return Boolean(target)
    }
  }
}
