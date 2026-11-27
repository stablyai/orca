import './assets/main.css'

import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { useAppStore } from './store'
import { NotchPanel } from './components/notch/NotchPanel'
import { I18nProvider } from './i18n/I18nProvider'
import type { GlobalSettings } from '../../shared/settings/global-settings-types'
import type { NotchSnapshot } from '../../shared/notch/notch-snapshot'

document.documentElement.classList.add('dark')
document.documentElement.dataset.orcaNotch = ''
function NotchRoot(): React.JSX.Element | null {
  useEffect(() => {
    let cancelled = false
    let initialized = false
    let pending: Partial<GlobalSettings> = {}
    const unsubscribe = window.api.settings.onChanged((updates) => {
      if (!initialized) {
        pending = { ...pending, ...updates }
        return
      }
      const settings = useAppStore.getState().settings
      if (settings) {
        useAppStore.setState({ settings: { ...settings, ...updates } })
      }
    })
    void window.api.settings.get().then((settings) => {
      if (!cancelled) {
        initialized = true
        useAppStore.setState({ settings: { ...settings, ...pending } })
        pending = {}
      }
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])
  const [snapshot, setSnapshot] = useState<NotchSnapshot | null>(null)

  useEffect(() => {
    let latestRevision = -1
    return window.api.notch?.onSnapshot((next) => {
      // Bounds changes and status changes race; a stale frame would paint the wrong widths.
      if (next.revision <= latestRevision) {
        return
      }
      latestRevision = next.revision
      setSnapshot(next)
    })
  }, [])

  return snapshot ? <NotchPanel snapshot={snapshot} /> : null
}

const rootElement = document.getElementById('root')
if (rootElement) {
  createRoot(rootElement).render(
    <StrictMode>
      <I18nProvider>
        <NotchRoot />
      </I18nProvider>
    </StrictMode>
  )
}
