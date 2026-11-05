// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'
import { mountShell } from './plugin-frame-shell-mount.test-fixture'

const descriptor = { version: 7, byteLength: 3, maxReadBytes: 262144, readOnly: true }

function requestId(shell: ReturnType<typeof mountShell>, method: string): number {
  const request = shell.posted().findLast((message) => message.method === method)
  if (typeof request?.id !== 'number') {
    throw new Error(`No ${method} request`)
  }
  return request.id
}

function answer(shell: ReturnType<typeof mountShell>, method: string, result: unknown): void {
  shell.fromHost({ orca: 1, kind: 'res', id: requestId(shell, method), result })
}

async function open() {
  const shell = mountShell('editor')
  const pending = shell.orca.document!.rangeSession()
  answer(shell, 'editor.rangeSession', descriptor)
  return { ...shell, session: await pending }
}

describe('orca.document.rangeSession', () => {
  it('exposes bounded bytes separately from the editable whole-document API', async () => {
    const shell = await open()
    expect(shell.session.value).toEqual(descriptor)
    const pending = shell.session.readRange({ version: 7, offset: 1, length: 10 })
    answer(shell, 'editor.readRange', {
      version: 7,
      bytes: new Uint8Array([22, 33]).buffer,
      eof: true
    })
    const result = await pending
    expect([...new Uint8Array(result.bytes)]).toEqual([22, 33])
    expect(result.eof).toBe(true)
    shell.fromHost({ orca: 1, kind: 'evt', event: 'editor.rangeDocument', payload: descriptor })
    await expect(shell.orca.document!.get()).rejects.toMatchObject({ code: 'not_permitted' })
    shell.session.dispose()
    answer(shell, 'editor.closeRanges', null)
  })

  it('cancels unfinished reads on invalidation and only advances after explicit reload', async () => {
    const shell = await open()
    let invalidated: unknown
    shell.session.onInvalidate((value) => {
      invalidated = value
    })
    const pending = shell.session.readRange({ version: 7, offset: 0, length: 3 })
    const rejected = expect(pending).rejects.toMatchObject({ code: 'cancelled' })
    const readId = requestId(shell, 'editor.readRange')
    shell.fromHost({ orca: 1, kind: 'evt', event: 'editor.rangeInvalidated', payload: descriptor })
    await rejected
    expect(invalidated).toEqual(descriptor)
    expect(shell.session.value.version).toBe(7)
    expect(shell.posted()).toContainEqual({ orca: 1, kind: 'cancel', id: readId })
    shell.fromHost({
      orca: 1,
      kind: 'res',
      id: readId,
      result: { version: 7, bytes: new ArrayBuffer(3), eof: true }
    })
    const reload = shell.session.reload()
    answer(shell, 'editor.reloadRanges', { ...descriptor, version: 9, byteLength: 5 })
    await expect(reload).resolves.toMatchObject({ version: 9, byteLength: 5 })
    expect(shell.session.value.version).toBe(9)
    shell.session.dispose()
    answer(shell, 'editor.closeRanges', null)
    await expect(
      shell.session.readRange({ version: 9, offset: 0, length: 1 })
    ).rejects.toMatchObject({ code: 'cancelled' })
  })

  it('replays an invalidated descriptor delivered before a remounted viewer subscribed', async () => {
    const shell = mountShell('editor')
    shell.fromHost({ orca: 1, kind: 'evt', event: 'editor.rangeInvalidated', payload: descriptor })
    const pending = shell.orca.document!.rangeSession()
    answer(shell, 'editor.rangeSession', descriptor)
    const session = await pending
    let invalidated: unknown
    session.onInvalidate((value) => {
      invalidated = value
    })
    await Promise.resolve()
    expect(invalidated).toEqual(descriptor)
    session.dispose()
    answer(shell, 'editor.closeRanges', null)
  })
})
