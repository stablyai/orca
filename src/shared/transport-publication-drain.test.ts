import { describe, expect, it, vi } from 'vitest'
import { TransportPublicationDrain } from './transport-publication-drain'

describe('TransportPublicationDrain', () => {
  it('waits for every tracked write, including writes tracked while draining', async () => {
    const publication = new TransportPublicationDrain(() => {})
    const first = publication.trackWrite()
    const done = vi.fn()
    const drain = publication.drain(new AbortController().signal).then(done)
    const second = publication.trackWrite()
    first({ ok: true })
    await Promise.resolve()
    expect(done).not.toHaveBeenCalled()
    expect(() => publication.assertDrained()).toThrow('transport_publication_not_drained')
    second({ ok: true })
    await drain
    expect(done).toHaveBeenCalledOnce()
  })

  it('ignores a repeated settlement of the same write', async () => {
    const publication = new TransportPublicationDrain(() => {})
    const settle = publication.trackWrite()
    const other = publication.trackWrite()
    settle({ ok: true })
    settle({ ok: true })
    expect(() => publication.assertDrained()).toThrow('transport_publication_not_drained')
    other({ ok: true })
    await publication.drain(new AbortController().signal)
  })

  it('aborts only the observer and keeps a later write failure sticky', async () => {
    const onFailure = vi.fn()
    const publication = new TransportPublicationDrain(() => {}, onFailure)
    const settle = publication.trackWrite()
    const controller = new AbortController()
    const drain = publication.drain(controller.signal)
    controller.abort(new Error('observer cancelled'))
    await expect(drain).rejects.toThrow('observer cancelled')
    settle({ ok: false, error: new Error('lost write') })
    expect(onFailure).toHaveBeenCalledOnce()
    await expect(publication.drain(new AbortController().signal)).rejects.toThrow('lost write')
    expect(() => publication.assertCurrent()).toThrow('lost write')
  })

  it('fails once when the transport it was bound to is replaced', async () => {
    let current = true
    const onFailure = vi.fn()
    const publication = new TransportPublicationDrain(() => {
      if (!current) {
        throw new Error('transport_replaced')
      }
    }, onFailure)
    const settle = publication.trackWrite()
    current = false
    const drain = publication.drain(new AbortController().signal)
    await expect(drain).rejects.toThrow('transport_replaced')
    settle({ ok: true })
    expect(() => publication.assertDrained()).toThrow('transport_replaced')
    expect(onFailure).toHaveBeenCalledOnce()
  })

  it('refuses construction against a transport that is already stale', () => {
    expect(
      () =>
        new TransportPublicationDrain(() => {
          throw new Error('transport_replaced')
        })
    ).toThrow('transport_replaced')
  })
})
