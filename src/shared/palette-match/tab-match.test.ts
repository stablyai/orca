import { describe, expect, it } from 'vitest'
import { buildPaletteTabDocument } from './tab-document'
import { matchPaletteTabDocument, preparePaletteTabQuery } from './tab-match'

const ABSOLUTE_PATH = '/work/centralized-notification/src/app.ts'

function match(query: string, paths: { secondary: string[]; container: string[] }) {
  const prepared = preparePaletteTabQuery(query)
  if (!prepared) {
    throw new Error(`query "${query}" did not prepare`)
  }
  const document = buildPaletteTabDocument({
    id: 'tab-1',
    title: 'app.ts',
    secondaryTexts: paths.secondary,
    containerSecondaryTexts: paths.container,
    worktreeName: 'Notification revamp',
    branch: 'demo/notification-revamp',
    repoName: 'acme/orca'
  })
  return matchPaletteTabDocument(document, prepared)
}

describe('editor tab absolute path as location evidence', () => {
  it('scores a workspace-folder hit inside the absolute path as container evidence', () => {
    const result = match('centralized', { secondary: ['src/app.ts'], container: [ABSOLUTE_PATH] })
    expect(result?.qualityClass).toBe('exact-evidence')
    // Ranges still land on the absolute path, which is rendered as secondary index 1.
    expect(result?.secondaryMatches.map((secondary) => secondary.index)).toEqual([1])
  })

  it('keeps a pasted full absolute path as a visible destination match', () => {
    const result = match(ABSOLUTE_PATH, { secondary: ['src/app.ts'], container: [ABSOLUTE_PATH] })
    expect(result?.qualityClass).toBe('exact-visible')
    expect(result?.rank.destination).toBe(1)
  })

  it('leaves ordinary secondary paths and URLs as visible matches', () => {
    const result = match('centralized', { secondary: [ABSOLUTE_PATH], container: [] })
    expect(result?.qualityClass).toBe('exact-visible')
  })
})
