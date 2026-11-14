import '../assets/main.css'

import { Suspense, useMemo, useState } from 'react'
import { lazyWithRetry as lazy } from '@/app-shell/startup/lazy-with-retry'
import ReactDOM from 'react-dom/client'
import { useTranslation } from 'react-i18next'
import WebConnect from './WebConnect'
import { RecoverableRenderErrorBoundary } from '../components/error-boundaries/RecoverableRenderErrorBoundary'
import {
  clearPairingInputFromAddressBar,
  decideWebPairingStartup,
  readPairingInputFromLocation
} from './web-pairing'
import {
  createStoredWebRuntimeEnvironment,
  readStoredWebRuntimeEnvironment,
  saveStoredWebRuntimeEnvironment
} from './web-runtime-environment'
import { installWebPreloadApi } from './web-preload-api'
import { initWebDeviceKeySupport } from './web-device-key-support'
import { WebPairingSecurityNotice } from './WebPairingSecurityNotice'
import { I18nProvider } from '../i18n/I18nProvider'
import { useTranslate } from '@/i18n/use-translate'
import { installOsFileDropCancellationGuard } from '../lib/files/drop/os-file-drop-cancellation-guard'
import { installBodyOverlayAttributes } from '../lib/overlay-interaction/body-overlay-attributes'
import { installAppKeyboardRouter } from '../lib/keyboard/app-keyboard-router'

const disposeOsFileDropGuard = installOsFileDropCancellationGuard()
import.meta.hot?.dispose(disposeOsFileDropGuard)
const disposeBodyOverlayAttributes = installBodyOverlayAttributes()
import.meta.hot?.dispose(disposeBodyOverlayAttributes)
installAppKeyboardRouter()
const App = lazy(() => import('../App'))

function WebRoot(): React.JSX.Element {
  const initialPairingInput = useMemo(() => readPairingInputFromLocation(window.location), [])
  // Why: current runtime links carry scope metadata. Runtime-scope offers keep
  // the instant save path; mobile/legacy-unknown offers must be shown/probed.
  const startupDecision = useMemo(() => {
    const decision = decideWebPairingStartup({
      initialPairingInput,
      storedEnvironment: readStoredWebRuntimeEnvironment()
    })
    if (
      decision.kind === 'auto-save-runtime-offer' ||
      decision.kind === 'confirm-replace-saved-server' ||
      (decision.kind === 'show-connect' && decision.initialPairingInput !== null)
    ) {
      clearPairingInputFromAddressBar()
    }
    return decision
  }, [initialPairingInput])
  const [hasEnvironment, setHasEnvironment] = useState(() => {
    if (startupDecision.kind === 'auto-save-runtime-offer') {
      saveStoredWebRuntimeEnvironment(
        createStoredWebRuntimeEnvironment({
          name: 'Orca Server',
          offer: startupDecision.offer,
          previousEnvironment: readStoredWebRuntimeEnvironment()
        })
      )
      return true
    }
    return startupDecision.kind === 'use-stored-environment'
  })

  if (!hasEnvironment) {
    return (
      <WebConnect
        initialPairingInput={
          startupDecision.kind === 'show-connect' ||
          startupDecision.kind === 'confirm-replace-saved-server'
            ? startupDecision.initialPairingInput
            : null
        }
        confirmReplacingSavedServer={startupDecision.kind === 'confirm-replace-saved-server'}
        onConnected={() => setHasEnvironment(true)}
      />
    )
  }

  installWebPreloadApi()
  return (
    <>
      <Suspense fallback={<div className="min-h-dvh bg-background" />}>
        <App />
      </Suspense>
      <WebPairingSecurityNotice />
    </>
  )
}

function WebRootBoundary(): React.JSX.Element {
  const t = useTranslate()
  useTranslation()
  return (
    <RecoverableRenderErrorBoundary
      boundaryId="web.root"
      surface="web-root"
      title={t('app.recoverableError.webTitle', 'Orca web hit a renderer error.')}
      description={t(
        'app.recoverableError.webDescription',
        'Retry the web client or reconnect to the paired runtime.'
      )}
    >
      <WebRoot />
    </RecoverableRenderErrorBoundary>
  )
}

// Why await: where a new pairing may be stored depends on what this browser can keep secret.
void initWebDeviceKeySupport()
  .catch((error: unknown) => console.warn('[web] Device key probe failed', error))
  .finally(() => {
    ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
      <I18nProvider>
        <WebRootBoundary />
      </I18nProvider>
    )
  })

// Prime WebGL here because web hosts terminals too; dynamic import keeps the App/pane-manager graph out of startup.
void import('../lib/pane-manager/terminal-rendering/pane-webgl-renderer')
  .then(() => import('../lib/pane-manager/terminal-rendering/terminal-webgl-addon-loader'))
  .then(({ primeTerminalWebglAddon }) => primeTerminalWebglAddon())
