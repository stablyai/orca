/// <reference types="vite/client" />

import type { PaneManager } from '@/lib/pane-manager/pane-manager'

declare global {
  var MonacoEnvironment:
    | {
        getWorker(workerId: string, label: string): Worker
      }
    | undefined
  // oxlint-disable-next-line typescript-eslint/consistent-type-definitions -- declaration merging requires interface
  interface Window {
    __paneManagers?: Map<string, PaneManager>
  }
}

export {}
