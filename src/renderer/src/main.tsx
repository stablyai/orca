import './assets/main.css'

import { startDesktopRenderer } from './desktop-renderer-bootstrap'

startDesktopRenderer({
  rootElement: document.getElementById('root'),
  preloadBridgeAvailable: typeof window.api === 'object',
  loadDesktopRenderer: async () => (await import('./desktop-renderer')).mountDesktopRenderer,
  webClientPath: import.meta.env.DEV ? '/web-index.html' : null
})
