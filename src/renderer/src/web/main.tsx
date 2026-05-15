import '../assets/main.css'

import { lazy, Suspense, useMemo, useState } from 'react'
import ReactDOM from 'react-dom/client'
import WebConnect from './WebConnect'
import {
  clearPairingInputFromAddressBar,
  parseWebPairingInput,
  readPairingInputFromLocation
} from './web-pairing'
import {
  createStoredWebRuntimeEnvironment,
  readStoredWebRuntimeEnvironment,
  saveStoredWebRuntimeEnvironment
} from './web-runtime-environment'
import { installWebPreloadApi } from './web-preload-api'

const App = lazy(() => import('../App'))

function WebRoot(): React.JSX.Element {
  const initialPairingInput = useMemo(() => readPairingInputFromLocation(window.location), [])
  const [hasEnvironment, setHasEnvironment] = useState(() => {
    const offer = initialPairingInput ? parseWebPairingInput(initialPairingInput) : null
    if (offer) {
      saveStoredWebRuntimeEnvironment(
        createStoredWebRuntimeEnvironment({ name: 'Orca Server', offer })
      )
      clearPairingInputFromAddressBar()
      return true
    }
    return readStoredWebRuntimeEnvironment() !== null
  })

  if (!hasEnvironment) {
    return (
      <WebConnect
        initialPairingInput={initialPairingInput}
        onConnected={() => setHasEnvironment(true)}
      />
    )
  }

  installWebPreloadApi()
  return (
    <Suspense fallback={<div className="min-h-screen bg-background" />}>
      <App />
    </Suspense>
  )
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(<WebRoot />)
