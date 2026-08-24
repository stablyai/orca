import { describe, expect, it } from 'vitest'
import {
  discardKagiPrivateInitialNavigation,
  getKagiPrivateInitialNavigation,
  queueKagiPrivateInitialNavigation
} from './kagi-private-initial-navigation'

describe('Kagi private initial navigation', () => {
  it('keeps the bearer URL separate from the model until navigation commits', () => {
    const modelUrl = 'https://kagi.com/search?q=private+project'
    const privateUrl = 'https://kagi.com/search?token=session-secret&q=private+project'

    queueKagiPrivateInitialNavigation('page-1', privateUrl)

    expect(getKagiPrivateInitialNavigation('page-1', modelUrl)).toEqual({
      modelUrl,
      navigationUrl: privateUrl
    })
    expect(getKagiPrivateInitialNavigation('page-1', modelUrl)).toEqual({
      modelUrl,
      navigationUrl: privateUrl
    })
    discardKagiPrivateInitialNavigation('page-1')
    expect(getKagiPrivateInitialNavigation('page-1', modelUrl)).toEqual({
      modelUrl,
      navigationUrl: modelUrl
    })
  })

  it('survives delayed and high-volume tab mounting without evicting credentials', () => {
    const privateUrl = 'https://kagi.com/search?token=session-secret'
    for (let index = 0; index < 64; index += 1) {
      queueKagiPrivateInitialNavigation(`page-${index}`, `${privateUrl}-${index}`)
    }

    expect(getKagiPrivateInitialNavigation('page-0', 'https://kagi.com/search').navigationUrl).toBe(
      `${privateUrl}-0`
    )
    for (let index = 0; index < 64; index += 1) {
      discardKagiPrivateInitialNavigation(`page-${index}`)
    }
  })

  it('bounds credentials retained for pages that never mount', () => {
    const modelUrl = 'https://kagi.com/search'
    for (let index = 0; index < 129; index += 1) {
      queueKagiPrivateInitialNavigation(
        `bounded-page-${index}`,
        `https://kagi.com/search?token=session-secret-${index}`
      )
    }

    expect(getKagiPrivateInitialNavigation('bounded-page-0', modelUrl).navigationUrl).toBe(modelUrl)
    expect(getKagiPrivateInitialNavigation('bounded-page-128', modelUrl).navigationUrl).toContain(
      'session-secret-128'
    )
    for (let index = 0; index < 129; index += 1) {
      discardKagiPrivateInitialNavigation(`bounded-page-${index}`)
    }
  })

  it('drops a stale credential when the page target changes before mount', () => {
    const privateUrl = 'https://kagi.com/search?token=session-secret&q=old'
    queueKagiPrivateInitialNavigation('page-changed', privateUrl)

    expect(
      getKagiPrivateInitialNavigation('page-changed', 'https://example.com/new-target')
    ).toEqual({
      modelUrl: 'https://example.com/new-target',
      navigationUrl: 'https://example.com/new-target'
    })
    expect(getKagiPrivateInitialNavigation('page-changed', 'about:blank').navigationUrl).toBe(
      'about:blank'
    )
  })

  it('rejects non-Kagi URLs and discards closed pages', () => {
    expect(() =>
      queueKagiPrivateInitialNavigation('page-invalid', 'https://example.com/?token=secret')
    ).toThrow('Expected a Kagi private-session URL.')

    queueKagiPrivateInitialNavigation('page-closed', 'https://kagi.com/search?token=session-secret')
    discardKagiPrivateInitialNavigation('page-closed')

    expect(getKagiPrivateInitialNavigation('page-closed', 'about:blank')).toEqual({
      modelUrl: 'about:blank',
      navigationUrl: 'about:blank'
    })
  })

  it('queues a single bearer token when the link carries duplicates', () => {
    const modelUrl = 'https://kagi.com/search?q=private+project'
    queueKagiPrivateInitialNavigation(
      'page-duplicate',
      'https://kagi.com/search?token=first-secret&q=private+project&token=second-secret'
    )

    expect(getKagiPrivateInitialNavigation('page-duplicate', modelUrl)).toEqual({
      modelUrl,
      navigationUrl: 'https://kagi.com/search?token=first-secret&q=private+project'
    })
    discardKagiPrivateInitialNavigation('page-duplicate')
  })

  it('redacts a defensive model fallback', () => {
    const privateUrl = 'https://kagi.com/search?token=session-secret&q=private+project'

    expect(getKagiPrivateInitialNavigation('page-missing', privateUrl)).toEqual({
      modelUrl: 'https://kagi.com/search?q=private+project',
      navigationUrl: 'https://kagi.com/search?q=private+project'
    })
  })
})
