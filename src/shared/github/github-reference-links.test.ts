import { describe, expect, it } from 'vitest'
import {
  bareGitHubReferenceRepoForChat,
  linkGitHubReferences,
  type GitHubRepoReference
} from './github-reference-links'

const workspaceRepo: GitHubRepoReference = { owner: 'stablyai', repo: 'orca' }

const noCode = (): ReadonlySet<number> => new Set()

describe('bareGitHubReferenceRepoForChat', () => {
  it.each([
    'Fixes #42.',
    'Fixes #42 and StablyAI/Orca#12 in https://github.com/stablyai/orca/pull/42.',
    'See https://github.com/stablyai/orca.git for #42.',
    'Screenshot for #42: https://github.com/user-attachments/assets/ce11040a',
    'Fixes #42 in src/other/repo#3 only.',
    'Fixes #42 in .other/repo#3 only.',
    'Fixes #42, not other/repo#3a.'
  ])('keeps the workspace repo for %j', (text) => {
    expect(bareGitHubReferenceRepoForChat(text, workspaceRepo, noCode)).toBe(workspaceRepo)
  })

  it.each([
    'Compare vercel/next.js#42 with #42.',
    'https://github.com/facebook/react/pull/144#issuecomment-1 supersedes #144.',
    'Looked into #42.\n\nSee https://github.com/other/repo，then stop.',
    'See `other/repo#3` for #42.'
  ])('yields bare refs for %j', (text) => {
    expect(bareGitHubReferenceRepoForChat(text, workspaceRepo, noCode)).toBeNull()
  })
})

describe('linkGitHubReferences', () => {
  it('leaves bare refs as text without a default repo while linking explicit ones', () => {
    const paragraph = {
      type: 'paragraph',
      children: [{ type: 'text', value: 'Compare vercel/next.js#42 with #42.' }]
    }

    linkGitHubReferences({ type: 'root', children: [paragraph] }, null)

    expect(paragraph.children).toEqual([
      { type: 'text', value: 'Compare ' },
      {
        type: 'link',
        url: 'https://github.com/vercel/next.js/issues/42',
        title: null,
        children: [{ type: 'text', value: 'vercel/next.js#42' }]
      },
      { type: 'text', value: ' with #42.' }
    ])
  })
})
