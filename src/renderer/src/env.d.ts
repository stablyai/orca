/// <reference types="vite/client" />

import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import type { OnboardingFeatureSetupDeps } from '@/components/onboarding/onboarding-feature-setup'
import type { languages } from 'monaco-editor'
import type { MonacoE2EProbe } from './components/editor/monaco-e2e-probe'
import type { TerminalWorktreeParkingDebugVerdict } from './components/terminal-pane/terminal-parking-e2e-overrides'
import type { TerminalPtyPreSpawnE2EBarrier } from './components/terminal-pane/terminal-pty-pre-spawn-e2e-barrier'
import type { LocalLayoutStreamE2EEnd } from './runtime/local-layout-stream-e2e-end'

declare module 'monaco-editor/esm/vs/basic-languages/python/python.js' {
  export const conf: languages.LanguageConfiguration
  export const language: languages.IMonarchLanguage
}

declare module 'monaco-editor/esm/vs/basic-languages/markdown/markdown.js' {
  export const conf: languages.LanguageConfiguration
  export const language: languages.IMonarchLanguage
}

declare module 'monaco-editor/esm/vs/basic-languages/cpp/cpp.js' {
  export const conf: languages.LanguageConfiguration
  export const language: languages.IMonarchLanguage
}

// Monaco contributions lack public types; declare only Orca’s paste-override surface.
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

// The same class the public `monaco.Uri` re-exports, reachable without loading the editor bundle.
declare module 'monaco-editor/esm/vs/base/common/uri.js' {
  export class URI {
    static file(path: string): URI
    static parse(value: string): URI
    static from(components: { scheme: string; authority?: string; path?: string }): URI
    readonly scheme: string
    readonly authority: string
    readonly path: string
    readonly fragment: string
    readonly fsPath: string
    with(change: { path?: string; fragment?: string }): URI
    toString(skipEncoding?: boolean): string
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

// Only the gutter-disposal patch test constructs this directly (config/patches/monaco-editor@0.55.1.patch).
declare module 'monaco-editor/esm/vs/editor/browser/widget/diffEditor/utils/editorGutter.js' {
  type GutterEvent = (listener: () => void) => { dispose(): void }
  type GutterRange = {
    startLineNumber: number
    endLineNumberExclusive: number
    intersect(other: unknown): unknown
  }
  export class EditorGutter {
    constructor(
      editor: {
        onDidScrollChange: GutterEvent
        onDidChangeModel: GutterEvent
        onDidChangeViewZones: GutterEvent
        onDidContentSizeChange: GutterEvent
        getScrollTop(): number
        hasModel(): boolean
        getModel(): { getLineCount(): number }
        getVisibleRanges(): { startLineNumber: number; endLineNumber: number }[]
        getTopForLineNumber(line: number, includeViewZones?: boolean): number
        getBottomForLineNumber(line: number, includeViewZones?: boolean): number
      },
      domNode: HTMLElement,
      itemProvider: {
        getIntersectingGutterItems(
          range: unknown,
          reader: unknown
        ): { id: string; range: GutterRange }[]
        createView(
          item: unknown,
          target: HTMLElement
        ): { layout(...args: unknown[]): void; dispose(): void }
      }
    )
    dispose(): void
  }
}

declare global {
  /** Full commit the build was made from, stamped by the renderer build. */
  const ORCA_BUILD_COMMIT: string
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
      /** A tab's scrollback across both store homes, via the one resolver production reads through. */
      resolveLeafScrollback: (tabId: string) => Record<string, string> | undefined
      retentionLimit: number | null
      worktreeVerdicts: () => TerminalWorktreeParkingDebugVerdict[]
    }
    __monacoEditorE2E?: MonacoE2EProbe
    __e2ePtyAppliedSizeReadDelayMs?: number
    __terminalPtyPreSpawnE2EBarrier?: TerminalPtyPreSpawnE2EBarrier
    __endLocalLayoutStreamE2E?: LocalLayoutStreamE2EEnd
    /** E2E builds only: whether a paired server's layout frames, not the mirror, draw the workspace. */
    __isFrameDrawnServerWorkspaceE2E?: (environmentId: string, worktreeId: string) => boolean
  }
}

// oxlint-disable-next-line typescript-eslint/consistent-type-definitions -- declaration merging requires interface
interface ImportMetaEnv {
  readonly VITE_DIRECT_SSH_RECONNECT_COORDINATOR?: string
  readonly VITE_EXPOSE_STORE?: boolean
  readonly VITE_SKILL_WARNING_PREVIEW?: string
}

export {}
