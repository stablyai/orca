import { Suspense } from 'react'
import { lazyWithRetry as lazy } from '@/app-shell/startup/lazy-with-retry'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import { usePlainSshPanels } from '@/ssh/plain-ssh-terminal-panels'

const PlainSshTerminalPanelsSurface = lazy(() => import('./PlainSshTerminalPanelsSurface'))

export function plainSshUnmanagedNotice(t: Translate = translate): string {
  return t(
    'auto.components.plainSshTerminal.unmanaged',
    'Plain SSH — unmanaged. Not an Orca workspace: agents and tabs here aren’t tracked, and this terminal isn’t restored. Closing it ends the SSH session.'
  )
}

export function PlainSshTerminalPanels(): React.JSX.Element | null {
  const panels = usePlainSshPanels()
  if (panels.length === 0) {
    return null
  }
  return (
    <Suspense fallback={null}>
      <PlainSshTerminalPanelsSurface panels={panels} />
    </Suspense>
  )
}
