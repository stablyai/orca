import { Suspense, useEffect, useState } from 'react'
import { lazyWithRetry } from '@/app-shell/startup/lazy-with-retry'
import type { StarNagMode } from './StarNagCardBody'

const ORCA_REPO_URL = 'https://github.com/stablyai/orca'

const LazyStarNagCardBody = lazyWithRetry(
  () => import('./StarNagCardBody').then((module) => ({ default: module.StarNagCardBody })),
  { reloadKey: 'star-nag-card-body' }
)

const openOrcaRepoUrl = (): Promise<void> => window.api.shell.openUrl(ORCA_REPO_URL)

/** Main owns visibility thresholds and GitHub checks. Keep the card until explicit action; nonterminal exits persist a cooldown. */
export function StarNagCard(): React.JSX.Element | null {
  const [visible, setVisible] = useState(false)
  const [busy, setBusy] = useState(false)
  const [mode, setMode] = useState<StarNagMode>('gh')

  useEffect(() => {
    const unsubscribeShow = window.api.starNag.onShow((payload) => {
      if (payload?.surface && payload.surface !== 'card') {
        setBusy(false)
        setVisible(false)
        return
      }
      setMode(payload?.mode === 'web' ? 'web' : 'gh')
      setVisible(true)
    })
    const unsubscribeHide = window.api.starNag.onHide(() => {
      setBusy(false)
      setVisible(false)
    })
    return () => {
      unsubscribeShow()
      unsubscribeHide()
    }
  }, [])

  if (!visible) {
    return null
  }

  return (
    <Suspense fallback={null}>
      <LazyStarNagCardBody
        mode={mode}
        busy={busy}
        onSetMode={setMode}
        onSetBusy={setBusy}
        onSetVisible={setVisible}
        openRepoUrl={openOrcaRepoUrl}
      />
    </Suspense>
  )
}
