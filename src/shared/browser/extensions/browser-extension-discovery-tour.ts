import type { ContextualTour } from '../../contextual-tours'

export const BROWSER_EXTENSION_DISCOVERY_TOUR = {
  id: 'browser-extensions',
  kind: 'announcement',
  preserveFocus: true,
  steps: [
    {
      id: 'browser-extensions-intro',
      title: 'Bring your Chrome extensions',
      body: 'Install from the Chrome Web Store and pin them next to the address bar.',
      targetSelector: '[data-contextual-tour-target="browser-extensions-control"]',
      requiredForStart: true,
      preferredPlacement: 'bottom',
      control: { kind: 'browser-extension-icons', colored: false },
      primaryAction: { kind: 'open-chrome-web-store', label: 'Open Web Store' },
      secondaryAction: { kind: 'complete', label: 'Got it' },
      advanceOnFeatureInteraction: 'browser-extensions'
    }
  ]
} as const satisfies ContextualTour
