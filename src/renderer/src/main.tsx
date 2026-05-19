import './assets/main.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { applyDocumentTheme } from './lib/document-theme'

if (import.meta.env.DEV) {
  import('react-grab').then(({ init }) => init())
  import('react-grab/styles.css')
}

applyDocumentTheme('system', { disableTransitions: false })

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
