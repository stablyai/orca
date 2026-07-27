import { ReferenceWidget as MonacoReferenceWidget } from 'monaco-editor/esm/vs/editor/contrib/gotoSymbol/browser/peek/referencesWidget.js'
import { translate } from '@/i18n/i18n'
import { isPathInsideWorktree } from '@/lib/terminal-links'
import { useAppStore } from '@/store'
import { openDetectedFilePath } from '@/components/terminal-pane/terminal-file-open-routing'
import { getPeekReferenceFilePath } from './monaco-peek-path-copy'

type PeekReferenceUri = { scheme?: string; authority?: string; path: string }

type ReferenceWidgetInstance = {
  _headElement?: HTMLElement
  _revealReference?: (...args: unknown[]) => Promise<unknown>
}

type ReferenceWidgetConstructor = {
  prototype: ReferenceWidgetInstance & {
    __orcaPeekOpenFileInstalled?: true
  }
}

export const PEEK_OPEN_TARGET_CLASS = 'orca-peek-open-target'

export function openPeekReferenceFile(filePath: string): void {
  const state = useAppStore.getState()
  let containing: { id: string; path: string } | undefined
  for (const worktrees of Object.values(state.worktreesByRepo)) {
    for (const worktree of worktrees) {
      if (
        isPathInsideWorktree(filePath, worktree.path) &&
        (!containing || worktree.path.length > containing.path.length)
      ) {
        containing = worktree
      }
    }
  }
  const openFile = state.openFiles.find((file) => file.filePath === filePath)
  openDetectedFilePath(filePath, null, null, {
    worktreeId: containing?.id ?? openFile?.worktreeId ?? '',
    worktreePath: containing?.path ?? '',
    runtimeEnvironmentId: openFile?.runtimeEnvironmentId
  })
}

function bindOpenTarget(element: HTMLElement, openTarget: (filePath: string) => void): void {
  if (element.dataset.orcaOpenBound) {
    return
  }
  element.dataset.orcaOpenBound = 'true'
  element.classList.add(PEEK_OPEN_TARGET_CLASS)
  const label = translate('auto.lib.monaco.peek.open.file.openFile', 'Click to open file')
  element.title = label
  // Why: peek closes when its embedded editor loses focus, so don't steal
  // focus on mousedown — the open happens on click.
  element.addEventListener('mousedown', (event) => {
    event.preventDefault()
    event.stopPropagation()
  })
  element.addEventListener('click', (event) => {
    const filePath = element.dataset.orcaOpenPath
    if (!filePath) {
      return
    }
    event.preventDefault()
    event.stopPropagation()
    openTarget(filePath)
  })
}

function ensureOpenableTitle(
  widget: ReferenceWidgetInstance,
  filePath: string,
  openTarget: (filePath: string) => void
): void {
  const titleElement = widget._headElement?.querySelector('.peekview-title')
  if (!titleElement) {
    return
  }
  for (const selector of ['.filename', '.dirname']) {
    const element = titleElement.querySelector<HTMLElement>(selector)
    if (!element) {
      continue
    }
    bindOpenTarget(element, openTarget)
    element.dataset.orcaOpenPath = filePath
  }
}

export function installMonacoPeekOpenFile(
  referenceWidget: ReferenceWidgetConstructor = MonacoReferenceWidget as unknown as ReferenceWidgetConstructor,
  openTarget: (filePath: string) => void = openPeekReferenceFile
): void {
  const prototype = referenceWidget.prototype
  if (prototype.__orcaPeekOpenFileInstalled) {
    return
  }
  const originalRevealReference = prototype._revealReference
  // Why: private Monaco member with no stability guarantee; if an upgrade
  // removes it, skip patching so peek keeps working without the open affordance.
  if (typeof originalRevealReference !== 'function') {
    return
  }

  prototype._revealReference = async function revealReferenceWithOpenableTitle(
    this: ReferenceWidgetInstance,
    ...args: unknown[]
  ): Promise<unknown> {
    const reference = args[0] as { uri?: PeekReferenceUri } | undefined
    if (reference?.uri && typeof reference.uri.path === 'string') {
      try {
        ensureOpenableTitle(this, getPeekReferenceFilePath(reference.uri), openTarget)
      } catch {
        // Optional title enhancement must not break Monaco's reveal.
      }
    }
    return originalRevealReference.apply(this, args)
  }

  prototype.__orcaPeekOpenFileInstalled = true
}
