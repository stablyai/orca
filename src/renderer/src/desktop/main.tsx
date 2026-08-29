import '../assets/main.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { useTranslation } from 'react-i18next'
import App from '../App'
import { RecoverableRenderErrorBoundary } from '../components/error-boundaries/RecoverableRenderErrorBoundary'
import { I18nProvider } from '../i18n/I18nProvider'
import { translate } from '../i18n/i18n'
import { applyDocumentTheme } from '../lib/document-theme'
import { installDesktopPreloadApi } from './desktop-preload-api'

applyDocumentTheme('system', { disableTransitions: false })

function DesktopRoot(): React.JSX.Element {
  useTranslation()
  return (
    <RecoverableRenderErrorBoundary
      boundaryId="app.root"
      surface="app-root"
      title={translate('app.recoverableError.rootTitle', 'Orca hit a renderer error.')}
      description={translate(
        'app.recoverableError.rootDescription',
        'The app shell could not finish rendering. Retry to remount it, or relaunch Orca if the error persists.'
      )}
    >
      <App />
    </RecoverableRenderErrorBoundary>
  )
}

async function bootDesktopRenderer(): Promise<void> {
  await installDesktopPreloadApi()
  const rootElement = document.getElementById('root')
  if (!rootElement) {
    throw new Error('Renderer root element not found.')
  }
  createRoot(rootElement).render(
    <StrictMode>
      <I18nProvider>
        <DesktopRoot />
      </I18nProvider>
    </StrictMode>
  )
}

void bootDesktopRenderer()
