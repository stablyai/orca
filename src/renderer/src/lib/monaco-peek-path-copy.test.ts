// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getPeekReferenceCopyPath,
  installMonacoPeekPathCopyButton,
  PEEK_COPY_PATH_BUTTON_CLASS,
  PEEK_COPY_PATH_COPIED_CLASS
} from './monaco-peek-path-copy'

type FakeReferenceWidgetInstance = {
  _headElement?: HTMLElement
  _revealReference?: (...args: unknown[]) => Promise<unknown>
}

function createReferenceWidgetConstructor(revealReference = vi.fn(async () => 'revealed')): {
  prototype: FakeReferenceWidgetInstance & { __orcaPeekPathCopyInstalled?: true }
  reveal: typeof revealReference
} {
  return {
    prototype: { _revealReference: revealReference },
    reveal: revealReference
  }
}

function createPeekHead(): HTMLElement {
  const head = document.createElement('div')
  const title = document.createElement('div')
  title.className = 'peekview-title'
  const filename = document.createElement('span')
  filename.className = 'filename'
  const dirname = document.createElement('span')
  dirname.className = 'dirname'
  title.appendChild(filename)
  title.appendChild(dirname)
  head.appendChild(title)
  return head
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('getPeekReferenceCopyPath', () => {
  it('converts windows drive model uris back to backslash paths', () => {
    expect(getPeekReferenceCopyPath({ path: '/C:/github/orca/src/x.ts' })).toBe(
      'C:\\github\\orca\\src\\x.ts'
    )
  })

  it('keeps posix paths untouched for remote/SSH files', () => {
    expect(getPeekReferenceCopyPath({ path: '/home/lucian/project/page.tsx' })).toBe(
      '/home/lucian/project/page.tsx'
    )
  })

  it('rebuilds UNC form for authority-qualified uris (WSL)', () => {
    expect(
      getPeekReferenceCopyPath({ authority: 'wsl.localhost', path: '/Ubuntu/home/x.ts' })
    ).toBe('\\\\wsl.localhost\\Ubuntu\\home\\x.ts')
  })
})

describe('installMonacoPeekPathCopyButton', () => {
  it('injects a copy button next to the path and copies via the IPC clipboard bridge', async () => {
    const writeClipboardText = vi.fn(async () => {})
    vi.stubGlobal('api', { ui: { writeClipboardText } })
    Object.assign(window, { api: { ui: { writeClipboardText } } })

    const widgetConstructor = createReferenceWidgetConstructor()
    installMonacoPeekPathCopyButton(widgetConstructor)

    const instance: FakeReferenceWidgetInstance = { _headElement: createPeekHead() }
    await widgetConstructor.prototype._revealReference?.call(instance, {
      uri: { path: '/home/lucian/project/page.tsx' }
    })

    const button = instance._headElement?.querySelector<HTMLButtonElement>(
      `.${PEEK_COPY_PATH_BUTTON_CLASS}`
    )
    expect(button).toBeTruthy()
    expect(button?.previousElementSibling?.className).toBe('dirname')

    button?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(writeClipboardText).toHaveBeenCalledWith('/home/lucian/project/page.tsx')
    expect(button?.classList.contains(PEEK_COPY_PATH_COPIED_CLASS)).toBe(true)
  })

  it('reuses one button across reveals and retargets its path', async () => {
    const writeClipboardText = vi.fn(async () => {})
    Object.assign(window, { api: { ui: { writeClipboardText } } })

    const widgetConstructor = createReferenceWidgetConstructor()
    installMonacoPeekPathCopyButton(widgetConstructor)

    const instance: FakeReferenceWidgetInstance = { _headElement: createPeekHead() }
    await widgetConstructor.prototype._revealReference?.call(instance, {
      uri: { path: '/C:/repo/a.ts' }
    })
    await widgetConstructor.prototype._revealReference?.call(instance, {
      uri: { path: '/C:/repo/b.ts' }
    })

    const buttons = instance._headElement?.querySelectorAll(`.${PEEK_COPY_PATH_BUTTON_CLASS}`)
    expect(buttons?.length).toBe(1)
    buttons?.[0].dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(writeClipboardText).toHaveBeenCalledWith('C:\\repo\\b.ts')
    expect(widgetConstructor.reveal).toHaveBeenCalledTimes(2)
  })

  it('leaves the widget untouched when the head is missing and does not double-install', async () => {
    const widgetConstructor = createReferenceWidgetConstructor()
    installMonacoPeekPathCopyButton(widgetConstructor)
    const patched = widgetConstructor.prototype._revealReference
    installMonacoPeekPathCopyButton(widgetConstructor)
    expect(widgetConstructor.prototype._revealReference).toBe(patched)

    const instance: FakeReferenceWidgetInstance = {}
    await expect(
      widgetConstructor.prototype._revealReference?.call(instance, {
        uri: { path: '/C:/repo/a.ts' }
      })
    ).resolves.toBe('revealed')
  })
})
