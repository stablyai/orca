import './assets/main.css'

import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { NotchPanel } from './components/notch/NotchPanel'
import { I18nProvider } from './i18n/I18nProvider'
import type { NotchSnapshot } from '../../shared/notch/notch-snapshot'

// Why: the notch is chrome, not app UI — it paints counts and nothing else, so it skips the
// theme and store bootstrap the main and pop-out roots need. It keeps i18n because its screen
// reader labels are the only text it has, and those must translate like every other surface.
//
// Pinning the dark token set is load-bearing, not cosmetic: the bar is permanently black to
// impersonate the camera housing, and under the light palette --foreground is near-black,
// which renders the working lane invisible.
document.documentElement.classList.add('dark')
function NotchRoot(): React.JSX.Element | null {
  const [snapshot, setSnapshot] = useState<NotchSnapshot | null>(null)

  useEffect(() => {
    let latestRevision = -1
    return window.api.notch.onSnapshot((next) => {
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
