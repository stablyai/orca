// @vitest-environment happy-dom

import { describe, expect, it, vi } from 'vitest'
import { installMonacoPeekOpenFile, PEEK_OPEN_TARGET_CLASS } from './monaco-peek-open-file'

type FakeReferenceWidgetInstance = {
  _headElement?: HTMLElement
  _revealReference?: (...args: unknown[]) => Promise<unknown>
}

function createReferenceWidgetConstructor(): {
  prototype: FakeReferenceWidgetInstance & { __orcaPeekOpenFileInstalled?: true }
} {
  return { prototype: { _revealReference: vi.fn(async () => 'revealed') } }
}

function createPeekHead(): HTMLElement {
  const head = document.createElement('div')
  const title = document.createElement('div')
  title.className = 'peekview-title'
  const filename = document.createElement('span')
  filename.className = 'filename'
  filename.textContent = 'WorksAdminList.tsx'
  const dirname = document.createElement('span')
  dirname.className = 'dirname'
  dirname.textContent = '/github/jh-portfolio/src/features/admin-works'
  title.appendChild(filename)
  title.appendChild(dirname)
  head.appendChild(title)
  return head
}

describe('installMonacoPeekOpenFile', () => {
  it('makes filename and dirname open the shown file, restoring the swallowed drive letter', async () => {
    const openTarget = vi.fn()
    const widgetConstructor = createReferenceWidgetConstructor()
    installMonacoPeekOpenFile(widgetConstructor, openTarget)

    const instance: FakeReferenceWidgetInstance = { _headElement: createPeekHead() }
    await widgetConstructor.prototype._revealReference?.call(instance, {
      uri: { scheme: 'c', path: '/github/jh-portfolio/src/features/admin-works/WorksAdminList.tsx' }
    })

    const filename = instance._headElement?.querySelector<HTMLElement>('.filename')
    const dirname = instance._headElement?.querySelector<HTMLElement>('.dirname')
    expect(filename?.classList.contains(PEEK_OPEN_TARGET_CLASS)).toBe(true)
    expect(dirname?.classList.contains(PEEK_OPEN_TARGET_CLASS)).toBe(true)
    expect(filename?.title).toBeTruthy()

    filename?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(openTarget).toHaveBeenCalledWith(
      'c:/github/jh-portfolio/src/features/admin-works/WorksAdminList.tsx'
    )
    dirname?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(openTarget).toHaveBeenCalledTimes(2)
  })

  it('retargets on later reveals without stacking listeners', async () => {
    const openTarget = vi.fn()
    const widgetConstructor = createReferenceWidgetConstructor()
    installMonacoPeekOpenFile(widgetConstructor, openTarget)

    const instance: FakeReferenceWidgetInstance = { _headElement: createPeekHead() }
    await widgetConstructor.prototype._revealReference?.call(instance, {
      uri: { path: '/home/user/a.ts' }
    })
    await widgetConstructor.prototype._revealReference?.call(instance, {
      uri: { path: '/home/user/b.ts' }
    })

    const filename = instance._headElement?.querySelector<HTMLElement>('.filename')
    filename?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(openTarget).toHaveBeenCalledTimes(1)
    expect(openTarget).toHaveBeenCalledWith('/home/user/b.ts')
  })

  it('does not double-install and tolerates a missing head', async () => {
    const widgetConstructor = createReferenceWidgetConstructor()
    installMonacoPeekOpenFile(widgetConstructor, vi.fn())
    const patched = widgetConstructor.prototype._revealReference
    installMonacoPeekOpenFile(widgetConstructor, vi.fn())
    expect(widgetConstructor.prototype._revealReference).toBe(patched)

    await expect(
      widgetConstructor.prototype._revealReference?.call({}, { uri: { path: '/x.ts' } })
    ).resolves.toBe('revealed')
  })

  it('preserves the original reveal when title enhancement throws', async () => {
    const widgetConstructor = createReferenceWidgetConstructor()
    installMonacoPeekOpenFile(widgetConstructor, vi.fn())
    const head = document.createElement('div')
    vi.spyOn(head, 'querySelector').mockImplementation(() => {
      throw new Error('unsupported Monaco title markup')
    })

    await expect(
      widgetConstructor.prototype._revealReference?.call(
        { _headElement: head },
        { uri: { path: '/x.ts' } }
      )
    ).resolves.toBe('revealed')
  })
})
