import { useLayoutEffect, useMemo, useRef } from 'react'
import { useAppStore } from '../store'
import { useSystemPrefersDark } from '../components/terminal-pane/use-system-prefers-dark'
import {
  applyWorkspaceChromeStyleVariables,
  resolveWorkspaceChromeStyleVariables
} from './workspace-chrome-appearance'

/** Keeps the document root's chrome variables in sync with the workspace chrome appearance setting. */
export function useWorkspaceChromeDocumentStyle(): void {
  const settings = useAppStore((s) => s.settings)
  const systemPrefersDark = useSystemPrefersDark()
  const variables = useMemo(
    () => resolveWorkspaceChromeStyleVariables(settings, systemPrefersDark),
    [settings, systemPrefersDark]
  )
  const appliedKeysRef = useRef<string[]>([])
  useLayoutEffect(() => {
    const style = document.documentElement.style
    appliedKeysRef.current = applyWorkspaceChromeStyleVariables(
      style,
      variables,
      appliedKeysRef.current
    )
    return () => {
      appliedKeysRef.current = applyWorkspaceChromeStyleVariables(
        style,
        undefined,
        appliedKeysRef.current
      )
    }
  }, [variables])
}
