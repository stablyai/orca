import './assets/main.css'

import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { useAppStore } from './store'
import { NotchPanel } from './components/notch/NotchPanel'
import { I18nProvider } from './i18n/I18nProvider'
import type { NotchSnapshot } from '../../shared/notch/notch-snapshot'

document.documentElement.classList.add('dark')
document.documentElement.dataset.orcaNotch = ''
function NotchRoot(): React.JSX.Element | null {
  useEffect(() => {
    const apply = (settings: Awaited<ReturnType<typeof window.api.settings.get>>): void => {
      useAppStore.setState({ settings })
    }
    void window.api.settings.get().then(apply)
    return window.api.settings.onChanged((updates) => {
      const settings = useAppStore.getState().settings
      if (settings) {
        apply({ ...settings, ...updates })
      }
    })
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
