import { describe, expect, it } from 'vitest'
import {
  AUTOMATION_LIST_SEARCH_AGENT_MAX_CODE_UNITS,
  AUTOMATION_LIST_SEARCH_HOST_MAX_CODE_UNITS,
  AUTOMATION_LIST_SEARCH_NAME_MAX_CODE_UNITS,
  AUTOMATION_LIST_SEARCH_PROJECT_MAX_CODE_UNITS,
  AUTOMATION_LIST_SEARCH_PROMPT_MAX_CODE_UNITS,
  AUTOMATION_LIST_SEARCH_QUERY_MAX_BYTES,
  AUTOMATION_LIST_SEARCH_WORKSPACE_MAX_CODE_UNITS,
  AUTOMATION_LIST_SEARCH_UNKNOWN_PROJECT,
  automationListSearchFieldsMatch,
  automationListSearchIndexMatches,
  buildAutomationListSearchFingerprint,
  buildAutomationListSearchIndex,
  buildAutomationProjectSearchText,
  clampAutomationListSearchQueryInput,
  filterByActiveAutomationListSearchQuery,
  filterByAutomationListSearch,
  filterByAutomationListSearchIndex,
  getActiveAutomationListSearchQuery,
  isAutomationListSearchQueryTooLarge,
  normalizeAutomationListSearchField,
  resolveAutomationListSearchQuery,
  truncateAutomationListSearchField
} from './automation-list-search'

describe('automation-list-search', () => {
  it('normalizes query casing and whitespace', () => {
    expect(getActiveAutomationListSearchQuery('  Auto PR  ')).toBe('auto pr')
    expect(resolveAutomationListSearchQuery('  Auto PR  ')).toEqual({
      status: 'active',
      query: 'auto pr'
    })
  })

  it('rejects oversized queries without searching', () => {
    const oversized = 'a'.repeat(AUTOMATION_LIST_SEARCH_QUERY_MAX_BYTES + 1)
    expect(isAutomationListSearchQueryTooLarge(oversized)).toBe(true)
    expect(getActiveAutomationListSearchQuery(oversized)).toBeNull()
    expect(resolveAutomationListSearchQuery(oversized)).toEqual({ status: 'too_large' })
    expect(
      automationListSearchFieldsMatch(
        { name: 'Auto PR', project: 'orca', prompt: 'nudge' },
        oversized
      )
    ).toBe(false)

    const items = [
      { id: '1', name: 'Auto PR', project: 'orca', prompt: 'nudge' },
      { id: '2', name: 'Nightly', project: 'mobile', prompt: 'ship' }
    ]
    // Why: oversized paste must leave the list unfiltered, not blank it.
    expect(filterByAutomationListSearch(items, oversized, (item) => item)).toBe(items)
  })

  it('rejects queries over the byte limit but under the code-unit limit', () => {
    // 3 UTF-8 bytes per character, so half the cap in code units is over it in bytes.
    const multiByte = '한'.repeat(AUTOMATION_LIST_SEARCH_QUERY_MAX_BYTES / 2)
    expect(multiByte.length).toBeLessThanOrEqual(AUTOMATION_LIST_SEARCH_QUERY_MAX_BYTES)
    expect(isAutomationListSearchQueryTooLarge(multiByte)).toBe(true)
    expect(resolveAutomationListSearchQuery(multiByte)).toEqual({ status: 'too_large' })
  })

  it('treats whitespace-only queries as inactive (no search work)', () => {
    expect(getActiveAutomationListSearchQuery('   \t  ')).toBeNull()
    expect(resolveAutomationListSearchQuery('   ')).toEqual({ status: 'inactive' })
    const items = [{ name: 'A', project: 'p1', prompt: 'one' }]
    expect(filterByAutomationListSearch(items, '  ', (item) => item)).toBe(items)
  })

  it('clamps stored query input so multi-MB pastes are discarded', () => {
    const hugePaste = 'a'.repeat(AUTOMATION_LIST_SEARCH_QUERY_MAX_BYTES * 100)
    const clamped = clampAutomationListSearchQueryInput(hugePaste)
    expect(clamped.length).toBe(AUTOMATION_LIST_SEARCH_QUERY_MAX_BYTES + 1)
    expect(isAutomationListSearchQueryTooLarge(clamped)).toBe(true)
    expect(clampAutomationListSearchQueryInput('auto pr')).toBe('auto pr')
  })

  it('caps indexed field length so huge prompts stay bounded', () => {
    const prompt = `${'x'.repeat(AUTOMATION_LIST_SEARCH_PROMPT_MAX_CODE_UNITS)}unique-tail-token`
    const index = buildAutomationListSearchIndex({
      name: 'Nightly',
      project: 'mobile',
      prompt
    })
    expect(index.prompt.length).toBe(AUTOMATION_LIST_SEARCH_PROMPT_MAX_CODE_UNITS)
    expect(automationListSearchIndexMatches(index, 'unique-tail-token')).toBe(false)
    expect(automationListSearchIndexMatches(index, 'xxxx')).toBe(true)
  })

  it('null-safely normalizes missing fields', () => {
    expect(normalizeAutomationListSearchField(null, 10)).toBe('')
    expect(normalizeAutomationListSearchField(undefined, 10)).toBe('')
    expect(
      buildAutomationListSearchIndex({
        name: 'Job',
        project: 'host',
        prompt: null as unknown as string
      }).prompt
    ).toBe('')
  })

  it('does not split surrogate pairs when truncating', () => {
    const emoji = '😀'
    const value = `${'a'.repeat(7)}${emoji}`
    expect(truncateAutomationListSearchField(value, 8)).toBe('a'.repeat(7))
    expect(truncateAutomationListSearchField(value, 9)).toBe(value)
  })

  it('indexes unknown project fallback for missing repos', () => {
    expect(buildAutomationProjectSearchText({})).toBe(AUTOMATION_LIST_SEARCH_UNKNOWN_PROJECT)
    expect(buildAutomationProjectSearchText({ displayName: '  ', path: null })).toBe(
      AUTOMATION_LIST_SEARCH_UNKNOWN_PROJECT
    )
    expect(buildAutomationProjectSearchText({ displayName: 'orca', path: '/tmp/orca' })).toBe(
      'orca /tmp/orca'
    )
    const index = buildAutomationListSearchIndex({
      name: 'Orphan',
      project: buildAutomationProjectSearchText({}),
      prompt: 'hi'
    })
    expect(automationListSearchIndexMatches(index, 'unknown')).toBe(true)
  })

  it('caps the searchable prompt at the first 2,048 characters', () => {
    // Design doc: the bound is a hard requirement, not a tuning knob.
    expect(AUTOMATION_LIST_SEARCH_PROMPT_MAX_CODE_UNITS).toBe(2048)
  })

  it('matches workspace, agent, and host alongside name, project, and prompt', () => {
    const fields = {
      name: 'Auto PR assignment',
      project: 'orca / main',
      workspace: 'feature/login-retry',
      agent: 'Claude Code',
      host: 'build-box',
      prompt: 'Assign reviewers for open PRs'
    }
    for (const query of ['assignment', 'ORCA', 'login-retry', 'claude', 'build-box', 'reviewers']) {
      expect(automationListSearchFieldsMatch(fields, query)).toBe(true)
    }
    expect(automationListSearchFieldsMatch(fields, 'missing')).toBe(false)
  })

  it('bounds every indexed field, so no axis grows with its source', () => {
    const index = buildAutomationListSearchIndex({
      name: 'n'.repeat(10_000),
      project: 'p'.repeat(10_000),
      workspace: 'w'.repeat(10_000),
      agent: 'a'.repeat(10_000),
      host: 'h'.repeat(10_000),
      prompt: 'x'.repeat(10_000)
    })
    expect(index.name.length).toBe(AUTOMATION_LIST_SEARCH_NAME_MAX_CODE_UNITS)
    expect(index.project.length).toBe(AUTOMATION_LIST_SEARCH_PROJECT_MAX_CODE_UNITS)
    expect(index.workspace.length).toBe(AUTOMATION_LIST_SEARCH_WORKSPACE_MAX_CODE_UNITS)
    expect(index.agent.length).toBe(AUTOMATION_LIST_SEARCH_AGENT_MAX_CODE_UNITS)
    expect(index.host.length).toBe(AUTOMATION_LIST_SEARCH_HOST_MAX_CODE_UNITS)
    expect(index.prompt.length).toBe(AUTOMATION_LIST_SEARCH_PROMPT_MAX_CODE_UNITS)
  })

  it('leaves absent workspace/agent/host axes empty rather than matching everything', () => {
    const index = buildAutomationListSearchIndex({ name: 'Job', project: 'orca', prompt: 'hi' })
    expect(index.workspace).toBe('')
    expect(index.agent).toBe('')
    expect(index.host).toBe('')
    expect(automationListSearchIndexMatches(index, 'anything')).toBe(false)
  })

  it('fingerprints the new axes and caps the prompt before hashing', () => {
    const base = { name: 'A', project: 'p1', workspace: 'w1', agent: 'g1', host: 'h1', prompt: 'x' }
    for (const field of ['workspace', 'agent', 'host'] as const) {
      expect(buildAutomationListSearchFingerprint([base])).not.toBe(
        buildAutomationListSearchFingerprint([{ ...base, [field]: 'changed' }])
      )
    }
    // Two prompts differing only past the cap are one row set as far as search is concerned.
    const prefix = 'y'.repeat(AUTOMATION_LIST_SEARCH_PROMPT_MAX_CODE_UNITS)
    expect(buildAutomationListSearchFingerprint([{ ...base, prompt: `${prefix}tail-a` }])).toBe(
      buildAutomationListSearchFingerprint([{ ...base, prompt: `${prefix}tail-b` }])
    )
  })

  it('separates row identity from content so a reorder changes the fingerprint', () => {
    const rows = [
      { name: 'A', project: 'p', prompt: 'one' },
      { name: 'B', project: 'p', prompt: 'two' }
    ]
    expect(buildAutomationListSearchFingerprint(rows, ['a', 'b'])).not.toBe(
      buildAutomationListSearchFingerprint(rows, ['b', 'a'])
    )
  })

  it('matches name, project, or prompt', () => {
    const fields = {
      name: 'Auto PR assignment',
      project: 'orca / main',
      prompt: 'Assign reviewers for open PRs'
    }
    expect(automationListSearchFieldsMatch(fields, 'assignment')).toBe(true)
    expect(automationListSearchFieldsMatch(fields, 'ORCA')).toBe(true)
    expect(automationListSearchFieldsMatch(fields, 'reviewers')).toBe(true)
    expect(automationListSearchFieldsMatch(fields, 'missing')).toBe(false)
  })

  it('filters by active query without re-resolving bounds', () => {
    const items = [
      { id: '1', name: 'Auto Issue assignment', project: 'orca', prompt: 'triage issues' },
      { id: '2', name: 'Nightly deploy', project: 'mobile', prompt: 'ship apk' },
      { id: '3', name: 'PR nudge', project: 'orca', prompt: 'remind reviewers' }
    ]
    const indexes = items.map((item) =>
      buildAutomationListSearchIndex({
        name: item.name,
        project: item.project,
        prompt: item.prompt
      })
    )
    expect(
      filterByActiveAutomationListSearchQuery(items, indexes, 'apk').map((item) => item.id)
    ).toEqual(['2'])
    expect(
      filterByAutomationListSearchIndex(items, indexes, 'orca').map((item) => item.id)
    ).toEqual(['1', '3'])
    expect(filterByAutomationListSearchIndex(items, indexes, '   ')).toBe(items)
    expect(
      filterByAutomationListSearchIndex(
        items,
        indexes,
        'a'.repeat(AUTOMATION_LIST_SEARCH_QUERY_MAX_BYTES + 1)
      )
    ).toBe(items)
    // Why: a desynchronized index must leave the list unfiltered, not blank it.
    expect(
      filterByActiveAutomationListSearchQuery(items, indexes.slice(0, 1), 'apk').map(
        (item) => item.id
      )
    ).toEqual(['1', '2', '3'])
  })

  it('builds a stable fingerprint from search sources only', () => {
    const sources = [
      { name: 'A', project: 'p1', prompt: 'one' },
      { name: 'B', project: 'p2', prompt: 'two' }
    ]
    expect(buildAutomationListSearchFingerprint(sources)).toBe(
      buildAutomationListSearchFingerprint([
        { name: 'A', project: 'p1', prompt: 'one' },
        { name: 'B', project: 'p2', prompt: 'two' }
      ])
    )
    expect(buildAutomationListSearchFingerprint(sources)).not.toBe(
      buildAutomationListSearchFingerprint([
        { name: 'A', project: 'p1', prompt: 'changed' },
        { name: 'B', project: 'p2', prompt: 'two' }
      ])
    )
  })
})
