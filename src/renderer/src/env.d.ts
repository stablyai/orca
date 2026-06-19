/// <reference types="vite/client" />

import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import type { OnboardingFeatureSetupDeps } from '@/components/onboarding/onboarding-feature-setup'
import type { languages } from 'monaco-editor'

declare module 'monaco-editor/esm/vs/basic-languages/python/python.js' {
  export const conf: languages.LanguageConfiguration
  export const language: languages.IMonarchLanguage
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
  }
}

// oxlint-disable-next-line typescript-eslint/consistent-type-definitions -- declaration merging requires interface
interface ImportMetaEnv {
  readonly VITE_EXPOSE_STORE?: boolean
}

export {}
