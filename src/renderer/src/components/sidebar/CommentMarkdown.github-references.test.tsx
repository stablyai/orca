// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import CommentMarkdown from './CommentMarkdown'

afterEach(cleanup)

const CONTENT = 'Fixes #12, unlike vercel/next.js#42.'
const REPO = { owner: 'stablyai', repo: 'orca' }

function linkTargets(chatGitHubReferences: boolean, content = CONTENT): (string | null)[] {
  const { container } = render(
    <CommentMarkdown
      content={content}
      githubRepo={REPO}
      chatGitHubReferences={chatGitHubReferences}
    />
  )
  return Array.from(container.querySelectorAll('a'), (link) => link.getAttribute('href'))
}

it('keeps bare refs on the repo in GitHub comments, where GitHub itself resolves them that way', () => {
  expect(linkTargets(false)).toEqual([
    'https://github.com/stablyai/orca/issues/12',
    'https://github.com/vercel/next.js/issues/42'
  ])
})

it('leaves bare refs as text in chat when the message names another repo', () => {
  expect(linkTargets(true)).toEqual(['https://github.com/vercel/next.js/issues/42'])
})

it.each([
  '```json\n{ "url": "https://github.com/other/repo" }\n```\n\nFixes #42.',
  '> ```text\n> https://github.com/other/repo\n> ```\n\nFixes #42.',
  '- ```text\n  other/repo#3\n\n  https://github.com/other/repo\n  ```\n\nFixes #42.',
  'Fixes #42.\n\n    https://github.com/other/repo'
])('keeps the workspace repo when another repo is only in code: %j', (content) => {
  expect(linkTargets(true, content)).toEqual(['https://github.com/stablyai/orca/issues/42'])
})

it.each([
  '```\nclosed\n```\nSee other/repo#3 and #42.',
  '- ```sh\n  echo hello\n  ```\n\nSee other/repo#3 and #42.',
  '> ```sh\n> echo hello\n\nSee other/repo#3 and #42.',
  '- Example:\n\n  ```sh\n  echo hello\n\nSee other/repo#3 and #42.',
  '```markdown\n> ```js\n> echo hello\n> ```\n```\n\nSee other/repo#3 and #42.',
  'See `other/repo#3` and #42.'
])('yields when another repo is outside code blocks: %j', (content) => {
  const expected = content.includes('`other/repo#3`')
    ? []
    : ['https://github.com/other/repo/issues/3']
  expect(linkTargets(true, content)).toEqual(expected)
})
