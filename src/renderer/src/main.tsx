import './assets/main.css'

import { bootstrapDesktopRenderer } from './desktop-renderer-bootstrap'

void bootstrapDesktopRenderer({
  rootElement: document.getElementById('root'),
  preloadBridgeAvailable: typeof window.api === 'object',
  loadDesktopRenderer: () => import('./desktop-renderer'),
  webClientPath: import.meta.env.DEV ? '/web-index.html' : null
})
