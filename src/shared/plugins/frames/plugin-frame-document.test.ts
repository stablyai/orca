// @vitest-environment happy-dom

import { describe, expect, it, vi } from 'vitest'
import { flush, mountShell } from './plugin-frame-shell-mount.test-fixture'

const doc = (version: number, text: string) => ({
  orca: 1,
  kind: 'evt',
  event: 'editor.document',
  payload: { version, readOnly: false, content: { kind: 'text', text } }
})
const answer = (id: number) => ({ orca: 1, kind: 'res', id, result: null })
const text = (value: string) => ({ kind: 'text', text: value })

describe('orca.document.get after applyEdit', () => {
  it('returns the accepted content at the version Orca sent', async () => {
    const { orca, fromHost } = mountShell('editor')
    const document = orca.document!
    fromHost(doc(3, 'a'))
    const edit = { baseVersion: 3, content: text('b') }
    const applied = document.applyEdit(edit)
    // Mutating the edit after sending must not change what get() reports.
    edit.content.text = 'mutated'
    await expect(document.get()).resolves.toMatchObject({ version: 3, content: text('a') })
    fromHost(answer(0))
    await expect(applied).resolves.toBeNull()
    await expect(document.get()).resolves.toEqual({
      version: 3,
      readOnly: false,
      content: text('b')
    })
  })

  it('keeps the old content when Orca refuses the edit', async () => {
    const { orca, fromHost } = mountShell('editor')
    fromHost(doc(1, 'a'))
    const applied = orca.document!.applyEdit({ baseVersion: 1, content: text('b') })
    fromHost({ orca: 1, kind: 'res', id: 0, error: { code: 'not_permitted', message: 'ro' } })
    await expect(applied).rejects.toMatchObject({ code: 'not_permitted' })
    await expect(orca.document!.get()).resolves.toMatchObject({ content: text('a') })
  })

  it('does not let a late acceptance overwrite a newer document', async () => {
    const { orca, fromHost } = mountShell('editor')
    fromHost(doc(1, 'a'))
    const applied = orca.document!.applyEdit({ baseVersion: 1, content: text('mine') })
    fromHost(doc(2, 'outside'))
    fromHost(answer(0))
    await applied
    await expect(orca.document!.get()).resolves.toMatchObject({
      version: 2,
      content: text('outside')
    })
  })

  it('does not report an accepted edit as a change', async () => {
    const { orca, fromHost } = mountShell('editor')
    fromHost(doc(1, 'a'))
    const changes = vi.fn()
    orca.document!.onDidChange(changes)
    await flush()
    const applied = orca.document!.applyEdit({ baseVersion: 1, content: text('b') })
    fromHost(answer(0))
    await applied
    expect(changes).toHaveBeenCalledTimes(1)
  })
})

describe('orca.document.onDidChange replay', () => {
  it('skips the replay for a subscription disposed before it runs', async () => {
    const { orca, fromHost } = mountShell('editor')
    fromHost(doc(1, 'a'))
    const changes = vi.fn()
    orca.document!.onDidChange(changes).dispose()
    await flush()
    fromHost(doc(2, 'b'))
    expect(changes).not.toHaveBeenCalled()
  })

  it('replays to subscriptions still live', async () => {
    const { orca, fromHost } = mountShell('editor')
    fromHost(doc(1, 'a'))
    const kept = vi.fn()
    const dropped = vi.fn()
    orca.document!.onDidChange(kept)
    orca.document!.onDidChange(dropped).dispose()
    await flush()
    expect(kept).toHaveBeenCalledWith(expect.objectContaining({ version: 1 }))
    expect(dropped).not.toHaveBeenCalled()
  })
})
