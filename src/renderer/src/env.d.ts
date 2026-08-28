/// <reference types="vite/client" />

import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import type { OnboardingFeatureSetupDeps } from '@/components/onboarding/onboarding-feature-setup'
import type { languages } from 'monaco-editor'
import type { MonacoE2EProbe } from './components/editor/monaco-e2e-probe'
import type { TerminalWorktreeParkingDebugVerdict } from './components/terminal-pane/terminal-parking-e2e-overrides'
import type { TerminalPtyPreSpawnE2EBarrier } from './components/terminal-pane/terminal-pty-pre-spawn-e2e-barrier'

declare module 'monaco-editor/esm/vs/basic-languages/python/python.js' {
  export const conf: languages.LanguageConfiguration
  export const language: languages.IMonarchLanguage
}

// Monaco ships these contributions without public type declarations. We only
// touch the paste-override surface, so declare the minimal shape we use.
declare module 'monaco-editor/esm/vs/editor/contrib/clipboard/browser/clipboard.js' {
  type PasteImplementation = () => boolean | Promise<unknown>
  export const PasteAction:
    | {
        addImplementation: (
          priority: number,
          name: string,
          implementation: PasteImplementation
        ) => { dispose: () => void }
      }
    | undefined
}

declare module 'monaco-editor/esm/vs/editor/browser/controller/editContext/clipboardUtils.js' {
  export const InMemoryClipboardMetadataManager: {
    INSTANCE: {
      get: (pastedText: string) => {
        isFromEmptySelection?: boolean
        multicursorText?: string[] | null
        mode?: string | null
      } | null
    }
  }
}

declare module 'monaco-editor/esm/vs/base/common/async.js' {
  export class Delayer<T = unknown> {
    constructor(defaultDelay: number)
    trigger(task: () => T | Promise<T>, delay?: number): Promise<T | undefined>
    cancel(): void
    dispose(): void
  }
}

declare module 'monaco-editor/esm/vs/base/common/lifecycle.js' {
  type Disposable = {
    dispose(): void
  }

  export class DisposableStore {
    add<T extends Disposable>(disposable: T): T
    clear(): void
    dispose(): void
  }
}

declare global {
  var MonacoEnvironment:
    | {
        getWorker(workerId: string, label: string): Worker
      }
    | undefined
  // oxlint-disable-next-line typescript-eslint/consistent-type-definitions -- declaration merging requires interface
  interface Window {
    __paneManagers?: Map<string, PaneManager>
    __onboardingFeatureSetupDeps?: OnboardingFeatureSetupDeps
    __terminalParkingDebug?: {
      parkDelayMs: number
      parkedTabIds: () => string[]
      retentionLimit: number | null
      worktreeVerdicts: () => TerminalWorktreeParkingDebugVerdict[]
    }
    __monacoEditorE2E?: MonacoE2EProbe
    __e2ePtyAppliedSizeReadDelayMs?: number
    __terminalPtyPreSpawnE2EBarrier?: TerminalPtyPreSpawnE2EBarrier
  }
}

// oxlint-disable-next-line typescript-eslint/consistent-type-definitions -- declaration merging requires interface
interface ImportMetaEnv {
  readonly VITE_DIRECT_SSH_RECONNECT_COORDINATOR?: string
  readonly VITE_EXPOSE_STORE?: boolean
  readonly VITE_SKILL_WARNING_PREVIEW?: string
}

export {}
