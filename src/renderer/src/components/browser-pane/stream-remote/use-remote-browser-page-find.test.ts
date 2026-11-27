import { expect, it } from 'vitest'
import { createRemoteBrowserFindTarget } from './use-remote-browser-page-find'

it('sends every Enter step, but drops searches a newer search or a stop superseded while they waited', async () => {
  const sent: string[] = []
  const answers: (() => void)[] = []
  const target = createRemoteBrowserFindTarget((method, params) => {
    sent.push(method === 'browser.stopFindInPage' ? 'stop' : `${params.text}:${params.findNext}`)
    return new Promise((resolve) =>
      answers.push(() => resolve({ activeMatchOrdinal: 1, matches: 2 }))
    )
  })
  const answerAll = async (): Promise<void> => {
    while (answers.length > 0) {
      answers.shift()!()
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
  }

  target.findInPage('a', { findNext: true })
  target.findInPage('ab', { findNext: true })
  target.findInPage('abc', { findNext: true })
  target.findInPage('abc', { forward: true, findNext: false })
  target.findInPage('abc', { forward: false, findNext: false })
  await answerAll()
  expect(sent).toEqual(['a:true', 'abc:true', 'abc:false', 'abc:false'])

  sent.length = 0
  target.findInPage('x', { findNext: true })
  target.findInPage('xy', { findNext: true })
  target.stopFindInPage('clearSelection')
  target.stopFindInPage('clearSelection')
  await answerAll()
  expect(sent).toEqual(['x:true', 'stop'])
})
