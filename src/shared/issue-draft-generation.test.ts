import { describe, expect, it } from 'vitest'
import { buildIssueFieldsPrompt, parseGeneratedIssueFields } from './issue-draft-generation'

describe('buildIssueFieldsPrompt', () => {
  it('embeds the draft, repository slug, labels, and the JSON output contract', () => {
    const prompt = buildIssueFieldsPrompt({
      currentTitle: 'Add a Print button',
      currentBody: 'Users want to print the document.',
      repoSlug: 'stablyai/orca',
      availableLabels: ['bug', 'enhancement', 'frontend']
    })
    expect(prompt).toContain(
      '{"title":"short title","body":"markdown description","labels":["label"]}'
    )
    expect(prompt).toContain('Repository: stablyai/orca')
    expect(prompt).toContain('Available labels: bug, enhancement, frontend')
    expect(prompt).toContain('Draft title: Add a Print button')
    expect(prompt).toContain('Users want to print the document.')
    expect(prompt).toContain('Return compact JSON only with keys title, body, and labels.')
  })

  it('marks missing draft fields, slug, and labels explicitly instead of leaving blanks', () => {
    const prompt = buildIssueFieldsPrompt({
      currentTitle: '',
      currentBody: '',
      repoSlug: null,
      availableLabels: []
    })
    expect(prompt).toContain('Repository: (unknown)')
    expect(prompt).toContain('Available labels: (none)')
    expect(prompt).toContain('Draft title: (empty)')
    expect(prompt).toContain('Draft description:\n(empty)')
  })

  it('appends a bounded additional user prompt when provided', () => {
    const prompt = buildIssueFieldsPrompt(
      { currentTitle: 'x', currentBody: '', repoSlug: null, availableLabels: [] },
      'Write in a formal tone.'
    )
    expect(prompt).toContain('Additional user prompt:\nWrite in a formal tone.')
  })

  it('truncates oversized drafts with an explicit marker', () => {
    const prompt = buildIssueFieldsPrompt({
      currentTitle: 'x',
      currentBody: 'a'.repeat(9_000),
      repoSlug: null,
      availableLabels: []
    })
    expect(prompt).toContain('[truncated: 1000 characters omitted]')
  })
})

describe('parseGeneratedIssueFields', () => {
  const fallback = {
    currentTitle: 'Fallback title',
    currentBody: 'Fallback body',
    availableLabels: ['bug', 'enhancement', 'Story']
  }
  const emptyDraft = { currentTitle: '', currentBody: '', availableLabels: [] }

  it('parses compact JSON and strips trailing periods from the title', () => {
    expect(
      parseGeneratedIssueFields(
        '{"title":"Add print support.","body":"## Summary\\nText\\n","labels":[]}',
        emptyDraft
      )
    ).toEqual({ title: 'Add print support', body: '## Summary\nText', labels: [] })
  })

  it('parses fenced output with surrounding prose', () => {
    const raw = 'Here you go:\n```json\n{"title":"A title","body":"Body"}\n```'
    expect(parseGeneratedIssueFields(raw, fallback)).toEqual({
      title: 'A title',
      body: 'Body',
      labels: []
    })
  })

  it('keeps only labels that exist in the repo, canonicalized to the repo spelling', () => {
    expect(
      parseGeneratedIssueFields(
        '{"title":"T","body":"B","labels":["BUG","story","invented","enhancement","bug"]}',
        fallback
      ).labels
    ).toEqual(['bug', 'Story', 'enhancement'])
  })

  it('drops non-string label entries and caps the label count', () => {
    const availableLabels = ['a', 'b', 'c', 'd', 'e']
    expect(
      parseGeneratedIssueFields('{"title":"T","body":"B","labels":[1,"a","b","c","d","e"]}', {
        ...fallback,
        availableLabels
      }).labels
    ).toEqual(['a', 'b', 'c', 'd'])
  })

  it('falls back to the current draft when fields are missing or empty', () => {
    expect(parseGeneratedIssueFields('{"title":"","body":""}', fallback)).toEqual({
      title: 'Fallback title',
      body: 'Fallback body',
      labels: []
    })
  })

  it('falls back to a generic title when the draft is empty too', () => {
    expect(parseGeneratedIssueFields('{"body":"Body"}', emptyDraft)).toEqual({
      title: 'New issue',
      body: 'Body',
      labels: []
    })
  })

  it('rejects non-object and malformed output', () => {
    expect(() => parseGeneratedIssueFields('"just a string"', fallback)).toThrow()
    expect(() => parseGeneratedIssueFields('no json at all', fallback)).toThrow()
  })
})
