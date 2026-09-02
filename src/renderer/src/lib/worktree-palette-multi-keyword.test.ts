import { describe, expect, it } from 'vitest'
import {
  CMD_J_FIXTURE_CASES,
  CMD_J_FIXTURE_PORTS,
  CMD_J_FIXTURE_REPO_MAP,
  CMD_J_FIXTURE_WORKTREES
} from './cmd-j-evaluation-fixture'
import { searchWorktrees, type PaletteSearchResult } from './worktree-palette-search'
import { buildWorktreePaletteDocuments } from './worktree-palette-document'
import { PALETTE_QUERY_MAX_TOKENS, preparePaletteQuery } from './palette-match/palette-query'
import { getWorktreeHostIdentity } from '../../../shared/worktree/host-qualified-identity'

function documentKey(worktreeId: string): string {
  return getWorktreeHostIdentity(
    CMD_J_FIXTURE_WORKTREES.find((worktree) => worktree.id === worktreeId)!
  )
}

function search(query: string, extra: Record<string, unknown> = {}): PaletteSearchResult[] {
  return searchWorktrees(CMD_J_FIXTURE_WORKTREES, query, CMD_J_FIXTURE_REPO_MAP, {
    workspacePortsByWorktreeId: CMD_J_FIXTURE_PORTS,
    ...extra
  })
}

function ids(query: string): string[] {
  return search(query).map((result) => result.worktreeId)
}

describe('cmd-j evaluation gate', () => {
  it.each(CMD_J_FIXTURE_CASES)('$query', ({ query, expected }) => {
    const matched = ids(query)
    expect(matched.slice().sort()).toEqual([...expected].sort())
    if (expected.length) {
      expect(matched[0]).toBe(expected[0])
    }
  })

  it('never reports a match without renderable evidence', () => {
    for (const { query, expected } of CMD_J_FIXTURE_CASES) {
      if (!expected.length) {
        continue
      }
      for (const result of search(query)) {
        const hasVisible =
          result.displayNameRanges.length > 0 ||
          result.branchRanges.length > 0 ||
          result.repoRanges.length > 0 ||
          result.hostRanges.length > 0
        expect(hasVisible || result.supportingText !== null).toBe(true)
      }
    }
  })
})

describe('token coverage', () => {
  it('matches across repo, name, and branch', () => {
    expect(ids('acme relay-reconnect')).toEqual(['wt-reconnect'])
  })

  it('keeps composite matching inside a multi-token query', () => {
    expect(ids('scan orca/main')).toEqual([])
    expect(ids('main orca/main')).toEqual(['wt-main-orca'])
  })

  it('removes prior results when an uncovered token is appended', () => {
    expect(ids('scan daily')).toHaveLength(2)
    expect(ids('scan daily 08-13')).toEqual(['wt-scan-daily'])
    expect(ids('scan daily 08-13 missing')).toEqual([])
  })

  it('cannot bypass short-token guards with a whole-query match', () => {
    // A single Latin letter may equal or prefix a word, never match mid-word.
    expect(ids('q')).toEqual([])
    expect(ids('a').length).toBeGreaterThan(0)
  })

  it('rejects more than the token limit', () => {
    const query = Array.from({ length: PALETTE_QUERY_MAX_TOKENS + 1 }, (_, i) => `t${i}`).join(' ')
    expect(preparePaletteQuery(query)).toEqual({ state: 'invalid', reason: 'too-many-tokens' })
    expect(ids(query)).toEqual([])
  })

  it('never fuzzy-matches identifiers', () => {
    for (const query of ['93334dd', '1.4.183', 'run-185', 'sta-4053', '3001']) {
      expect(ids(query)).toEqual([])
    }
  })
})

describe('evidence and ranking', () => {
  it('reads automation and linked-task data without optional caches', () => {
    expect(ids('nightly review run-184')).toEqual(['wt-scan-daily'])
    expect(ids('sta-4052')).toEqual(['wt-reconnect'])
  })

  it('renders one supporting-evidence row for a hidden match', () => {
    const [result] = search('reconnect infra')
    expect(result.supportingText?.labelKind).toBe('comment')
    expect(result.supportingText?.matchRanges).toHaveLength(1)
    expect(result.supportingText?.accessibilityLabel).toBe('Workspace comment')
  })

  it('rejects assignments that need two hidden sources', () => {
    // `vite` is only in the port evidence; `4052` only in another worktree's task.
    expect(ids('vite reconnect')).toEqual([])
  })

  it('prefers visible identity over supporting evidence', () => {
    const [result] = search('docs')
    expect(result.rank?.usesSupportingEvidence).toBe(0)
    expect(result.qualityClass).toBe('exact-visible')
  })

  it('ranks an exact identifier above an incidental numeric substring', () => {
    const [exact] = search('#4123')
    expect(exact.supportingText?.labelKind).toBe('pr')
    expect(exact.qualityClass).toBe('exact-evidence')
    // A port prefix is the only reading of `412`, and it ranks below the exact hit.
    const [partial] = search('412')
    expect(partial.supportingText?.labelKind).toBe('port')
    expect(partial.qualityClass).toBe('partial-evidence')
  })

  it('classifies a typo hit as fuzzy evidence', () => {
    const [result] = search('reconect')
    expect(result.worktreeId).toBe('wt-reconnect')
    expect(result.qualityClass).toBe('fuzzy-evidence')
    expect(result.rank?.fuzzyTokenCount).toBe(1)
  })
})

describe('kanban board profile', () => {
  it('ignores palette-only evidence', () => {
    expect(
      searchWorktrees(CMD_J_FIXTURE_WORKTREES, 'main 3000', CMD_J_FIXTURE_REPO_MAP, {
        workspacePortsByWorktreeId: CMD_J_FIXTURE_PORTS,
        evidencePolicy: 'board'
      })
    ).toEqual([])
  })

  it('still matches the comment printed on the card', () => {
    const matched = searchWorktrees(
      CMD_J_FIXTURE_WORKTREES,
      'reconnect infra',
      CMD_J_FIXTURE_REPO_MAP,
      { evidencePolicy: 'board' }
    )
    expect(matched.map((result) => result.worktreeId)).toEqual(['wt-reconnect'])
  })
})

describe('document invalidation inputs', () => {
  it('indexes the rendered host label only when one is supplied', () => {
    expect(ids('bastion')).toEqual([])
    const withHost = searchWorktrees(CMD_J_FIXTURE_WORKTREES, 'bastion', CMD_J_FIXTURE_REPO_MAP, {
      hostLabelByWorktreeId: new Map([['wt-docs', 'bastion']])
    })
    expect(withHost.map((result) => result.worktreeId)).toEqual(['wt-docs'])
    expect(withHost[0].hostRanges).toHaveLength(1)
  })

  it('rebuilds documents when a port appears without the worktree array changing', () => {
    const before = buildWorktreePaletteDocuments(CMD_J_FIXTURE_WORKTREES, {
      repoMap: CMD_J_FIXTURE_REPO_MAP
    })
    const after = buildWorktreePaletteDocuments(CMD_J_FIXTURE_WORKTREES, {
      repoMap: CMD_J_FIXTURE_REPO_MAP,
      workspacePortsByWorktreeId: CMD_J_FIXTURE_PORTS
    })
    // Documents are keyed by host identity so two same-id workspaces on different hosts
    // keep separate entries.
    const key = documentKey('wt-main-orca')
    expect(before.get(key)?.evidenceUnits.has('port:3000')).toBe(false)
    expect(after.get(key)?.evidenceUnits.has('port:3000')).toBe(true)
  })

  it('keeps recency and current-tab state out of normalized field data', () => {
    const documents = buildWorktreePaletteDocuments(CMD_J_FIXTURE_WORKTREES, {
      repoMap: CMD_J_FIXTURE_REPO_MAP
    })
    const fieldIds = [...(documents.get(documentKey('wt-docs'))?.fields ?? [])].map(
      (field) => field.id
    )
    // Guard the guard: a missing document would make the assertions below vacuous.
    expect(fieldIds.length).toBeGreaterThan(0)
    expect(fieldIds).not.toContain('recency')
    expect(fieldIds).not.toContain('isCurrent')
  })
})
