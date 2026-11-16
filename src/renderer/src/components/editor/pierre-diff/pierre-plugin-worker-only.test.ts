// @vitest-environment happy-dom
import { expect, it } from 'vitest'
import { getSharedHighlighter, registerCustomLanguage } from '@pierre/diffs'

it('keeps a worker-only plugin pattern out of the renderer highlighter', async () => {
  registerCustomLanguage('worker-only-test', async () => ({
    default: [
      {
        name: 'worker-only-test',
        scopeName: 'source.worker-only-test',
        workerOnly: true,
        repository: {},
        patterns: [{ match: '(?<=', name: 'keyword.control' }]
      }
    ]
  }))
  const highlighter = await getSharedHighlighter({
    langs: ['worker-only-test'],
    themes: ['dark-plus']
  })
  expect(
    highlighter
      .codeToTokens('hello', { lang: 'worker-only-test', theme: 'dark-plus' })
      .tokens[0].map((token) => token.content)
  ).toEqual(['hello'])
})
