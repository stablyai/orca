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

  it('chooses a literal secondary proof over a primary typo', () => {
    const match = matchTitleAndPath('atlaz', '/notes/atlas/')
    expect(match?.secondaryMatches).toHaveLength(1)
    expect(match?.rank).toMatchObject({ recovery: 0, wordMatch: 0, coverage: 1 })
  })

  it('uses the stronger secondary proof when another token already requires container coverage', () => {
    const match = matchPaletteTabDocument(
      buildPaletteTabDocument({
        id: 'tab',
        title: 'alphabet',
        secondaryTexts: ['/alpha'],
        worktreeName: 'beta',
        branch: 'main',
        repoName: 'repo'
      }),
      ready('alpha beta')
    )
    expect(match?.rank).toMatchObject({ coverage: 2, strength: 0 })
    expect(match?.titleRanges).toEqual([])
    expect(match?.secondaryMatches).toEqual([{ index: 0, ranges: [{ start: 1, end: 6 }] }])
    expect(match?.worktreeRanges).toEqual([{ start: 0, end: 4 }])
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

  it('restores contained secondary fields and preserves every selected representation', () => {
    const restored = matchTitleAndPath('foobar', 'bar', 'b')
    expect(restored?.secondaryMatches[0]?.ranges).toEqual([{ start: 0, end: 1 }])

    const multi = matchPaletteTabDocument(
      buildPaletteTabDocument({
        id: 'editor',
        title: 'main.ts',
        secondaryTexts: ['src/main.ts', '/home/me/project/src/main.ts'],
        worktreeName: 'workspace',
        branch: 'main',
        repoName: 'repo'
      }),
      ready('src/main.ts /home/me')
    )
    expect(multi?.secondaryMatches.map((proof) => proof.index)).toEqual([0, 1])
  })

  it('promotes eligible equality but not repository equality', () => {
    const eligible = matchTitleAndPath('notes', '/tmp/atlas', '/tmp/atlas')
    const ineligible = matchPaletteTabDocument(
      buildPaletteTabDocument({
        id: 'repo-hit',
        title: 'notes',
        secondaryTexts: [],
        worktreeName: 'workspace',
        branch: 'main',
        repoName: '/tmp/atlas'
      }),
      ready('/tmp/atlas')
    )
    expect(eligible?.rank.destination).toBe(1)
    expect(ineligible?.rank.destination).toBe(2)
  })

  it('recognizes only a single complete compatible sigilled number', () => {
    const document = buildPaletteDocument({
      id: 'review',
      visibleFields: [
        {
          id: 'name',
          profile: 'structured-label',
          text: 'migration',
          role: 'primary',
          destinationEligible: true
        }
      ],
      evidence: [
        {
          unit: { id: 'pr', kind: 'pr', text: '#123', accessibilityLabel: 'Pull request' },
          fields: [
            {
              id: 'pr-number',
              profile: 'identifier',
              text: '#123',
              evidenceId: 'pr',
              renderOffset: 0,
              identifier: { kind: 'number', sigil: '#' }
            }
          ]
        }
      ]
    })
    const run = (query: string) => {
      const prepared = ready(query)
      return matchPaletteDocument({
        document,
        tokens: prepared.tokens,
        normalizedQuery: prepared.normalized,
        tokenCountBeforeDeduplication: prepared.tokenCountBeforeDeduplication
      })
    }
    expect(run('#123')?.rank.destination).toBe(0)
    expect(run('#123 #123')?.rank.destination).toBe(2)
    expect(run('#123 migration')?.rank.destination).toBe(2)
    expect(run('123')?.rank.destination).toBe(2)
    expect(run('!123')).toBeNull()
  })

  it('uses the proof with fewer container-only tokens', () => {
    const match = matchPaletteTabDocument(
      buildPaletteTabDocument({
        id: 'tab',
        title: 'atlas',
        secondaryTexts: [],
        worktreeName: 'atlas sprint',
        branch: 'main',
        repoName: 'repo'
      }),
      ready('atlas sprint')
    )
    expect(match?.rank).toMatchObject({
      coverage: 2,
      containerOnlyTokenCount: 1,
      placement: 2
    })
    expect(match?.qualityClass).toBe('exact-visible')
    expect(match?.titleRanges).toHaveLength(1)
    expect(match?.worktreeRanges).toHaveLength(1)
  })

  it('finds a later word-boundary phrase after an incidental first occurrence', () => {
    const match = matchTitleAndPath('xatlas sprint Atlas sprint notes', '', 'atlas sprint')
    expect(match?.rank.placement).toBe(1)
  })
})
