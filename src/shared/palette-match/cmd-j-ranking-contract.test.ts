import { describe, expect, it } from 'vitest'
import { buildPaletteDocument, comparePaletteDocumentRank } from './palette-document'
import { matchPaletteDocument } from './match-document'
import { preparePaletteQuery } from './palette-query'
import { buildPaletteTabDocument } from './tab-document'
import { matchPaletteTabDocument } from './tab-match'

function ready(query: string) {
  const prepared = preparePaletteQuery(query)
  if (prepared.state !== 'ready') {
    throw new Error(`Expected ready query: ${query}`)
  }
  return prepared
}

function matchTitleAndPath(title: string, path: string, query = 'atlas') {
  return matchPaletteTabDocument(
    buildPaletteTabDocument({
      id: title,
      title,
      secondaryTexts: [path],
      worktreeName: 'workspace',
      branch: 'main',
      repoName: 'repo'
    }),
    ready(query)
  )
}

describe('Cmd+J semantic proof contract', () => {
  it('puts a path word boundary above a mid-word title, but a title word above that path', () => {
    const path = matchTitleAndPath('megatlascope', '/notes/atlas/')
    const title = matchTitleAndPath('Atlas planning', '/notes/atlas/')
    expect(path?.secondaryMatches).toHaveLength(1)
    expect(title?.titleRanges).toHaveLength(1)
    expect(path && title && comparePaletteDocumentRank(title.rank, path.rank)).toBeLessThan(0)
  })

  it('chooses the same semantic proof regardless of field source order', () => {
    const field = (id: string, role: 'secondary' | 'container') => ({
      id,
      profile: 'structured-label' as const,
      text: 'alpha',
      role,
      destinationEligible: false
    })
    const match = (visibleFields: ReturnType<typeof field>[]) => {
      const query = ready('alpha beta')
      return matchPaletteDocument({
        document: buildPaletteDocument({
          id: 'order-invariant',
          visibleFields: [
            ...visibleFields,
            {
              id: 'beta',
              profile: 'structured-label',
              text: 'beta',
              role: 'container',
              destinationEligible: false
            }
          ],
          evidence: []
        }),
        tokens: query.tokens,
        normalizedQuery: query.normalized
      })
    }

    const containerFirst = match([field('container', 'container'), field('secondary', 'secondary')])
    const secondaryFirst = match([field('secondary', 'secondary'), field('container', 'container')])
    expect(containerFirst?.rank).toEqual(secondaryFirst?.rank)
    expect(containerFirst?.assignments.map((assignment) => assignment.fieldId)).toEqual([
      'secondary',
      'beta'
    ])
    expect(secondaryFirst?.assignments.map((assignment) => assignment.fieldId)).toEqual([
      'secondary',
      'beta'
    ])
  })
})
