import { ReferenceWidget as MonacoReferenceWidget } from 'monaco-editor/esm/vs/editor/contrib/gotoSymbol/browser/peek/referencesWidget.js'
import { translate } from '@/i18n/i18n'

type PeekReferenceUri = { authority?: string; path: string }

type ReferenceWidgetInstance = {
  _headElement?: HTMLElement
  _revealReference?: (...args: unknown[]) => Promise<unknown>
}

type ReferenceWidgetConstructor = {
  prototype: ReferenceWidgetInstance & {
    __orcaPeekPathCopyInstalled?: true
  }
}

export const PEEK_COPY_PATH_BUTTON_CLASS = 'orca-peek-copy-path'
export const PEEK_COPY_PATH_COPIED_CLASS = 'orca-peek-copy-path--copied'
const PEEK_COPY_PATH_COPIED_FEEDBACK_MS = 1200

// Monaco model URIs keep posix-style paths ('/C:/repo/x.ts', '/home/user/x.ts',
// authority-qualified for UNC/WSL). Map them back to the filesystem form the
// user would paste elsewhere; never let Uri.fsPath backslash a remote posix path.
export function getPeekReferenceCopyPath(uri: PeekReferenceUri): string {
  if (uri.authority) {
    return `\\\\${uri.authority}${uri.path.replace(/\//g, '\\')}`
  }
  const windowsMatch = /^\/([A-Za-z]:)(\/.*)?$/.exec(uri.path)
  if (windowsMatch) {
    return windowsMatch[1] + (windowsMatch[2] ?? '/').replace(/\//g, '\\')
  }
  return uri.path
}

function createSvgIcon(className: string, shapes: Record<string, string>[]): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('class', className)
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('width', '12')
  svg.setAttribute('height', '12')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '2')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  for (const shape of shapes) {
    const { tag, ...attributes } = shape
    const element = document.createElementNS('http://www.w3.org/2000/svg', tag)
    for (const [name, value] of Object.entries(attributes)) {
      element.setAttribute(name, value)
    }
    svg.appendChild(element)
  }
  return svg
}

function createPeekCopyPathButton(): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = PEEK_COPY_PATH_BUTTON_CLASS
  const label = translate('auto.lib.monaco.peek.path.copy.copyPath', 'Copy path')
  button.title = label
  button.setAttribute('aria-label', label)
  button.appendChild(
    createSvgIcon('orca-peek-copy-path-icon', [
      { tag: 'rect', x: '9', y: '9', width: '13', height: '13', rx: '2' },
      { tag: 'path', d: 'M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1' }
    ])
  )
  button.appendChild(
    createSvgIcon('orca-peek-copy-path-check', [{ tag: 'polyline', points: '20 6 9 17 4 12' }])
  )
  // Why: peek closes when its embedded editor loses focus, so the button must
  // not steal focus on mousedown — copy happens on click without a focus swap.
  button.addEventListener('mousedown', (event) => {
    event.preventDefault()
    event.stopPropagation()
  })
  button.addEventListener('click', (event) => {
    event.preventDefault()
    event.stopPropagation()
    const path = button.dataset.orcaCopyPath
    if (!path) {
      return
    }
    void window.api.ui.writeClipboardText(path).catch(() => undefined)
    button.classList.add(PEEK_COPY_PATH_COPIED_CLASS)
    window.setTimeout(() => {
      button.classList.remove(PEEK_COPY_PATH_COPIED_CLASS)
    }, PEEK_COPY_PATH_COPIED_FEEDBACK_MS)
  })
  return button
}

function ensurePeekCopyPathButton(widget: ReferenceWidgetInstance, copyPath: string): void {
  const titleElement = widget._headElement?.querySelector('.peekview-title')
  if (!titleElement) {
    return
  }
  let button = titleElement.querySelector<HTMLButtonElement>(`.${PEEK_COPY_PATH_BUTTON_CLASS}`)
  if (!button) {
    button = createPeekCopyPathButton()
    const pathElement = titleElement.querySelector('.dirname')
    if (pathElement) {
      pathElement.after(button)
    } else {
      titleElement.appendChild(button)
    }
  }
  button.dataset.orcaCopyPath = copyPath
}

export function installMonacoPeekPathCopyButton(
  referenceWidget: ReferenceWidgetConstructor = MonacoReferenceWidget as unknown as ReferenceWidgetConstructor
): void {
  const prototype = referenceWidget.prototype
  if (prototype.__orcaPeekPathCopyInstalled) {
    return
  }
  const originalRevealReference = prototype._revealReference
  // Why: private Monaco member with no stability guarantee; if an upgrade
  // removes it, skip patching so peek keeps working without the copy button.
  if (typeof originalRevealReference !== 'function') {
    return
  }

  prototype._revealReference = async function revealReferenceWithCopyPathButton(
    this: ReferenceWidgetInstance,
    ...args: unknown[]
  ): Promise<unknown> {
    const reference = args[0] as { uri?: PeekReferenceUri } | undefined
    if (reference?.uri && typeof reference.uri.path === 'string') {
      ensurePeekCopyPathButton(this, getPeekReferenceCopyPath(reference.uri))
    }
    return originalRevealReference.apply(this, args)
  }

  prototype.__orcaPeekPathCopyInstalled = true
}
