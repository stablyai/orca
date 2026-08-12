import { describe, expect, it } from 'vitest'
import {
  normalizeBeadsIssue,
  normalizeBeadsIssueComment,
  normalizeBeadsIssueDetails,
  normalizeBeadsIssueRelation
} from './beads-types'

// Real `bd list --json` item shape probed with bd 1.1.2.
const RAW_BD_ITEM = {
  id: 'beads-probe-ay8',
  title: 'Wire the beads task source',
  description: 'Longer body text',
  status: 'in_progress',
  priority: 2,
  issue_type: 'feature',
  assignee: 'ada',
  owner: 'creator@example.com',
  created_at: '2026-08-01T10:00:00Z',
  created_by: 'creator@example.com',
  updated_at: '2026-08-10T12:34:56Z',
  started_at: '2026-08-02T09:00:00Z',
  labels: ['backend', 'cli'],
  dependency_count: 1,
  dependent_count: 2,
  comment_count: 3
}

describe('normalizeBeadsIssue', () => {
  it('maps the probed bd 1.1.2 item shape to camelCase', () => {
    expect(normalizeBeadsIssue(RAW_BD_ITEM)).toEqual({
      id: 'beads-probe-ay8',
      title: 'Wire the beads task source',
      description: 'Longer body text',
      status: 'in_progress',
      priority: 2,
      issueType: 'feature',
      assignee: 'ada',
      createdBy: 'creator@example.com',
      labels: ['backend', 'cli'],
      createdAt: '2026-08-01T10:00:00Z',
      updatedAt: '2026-08-10T12:34:56Z',
      dependencyCount: 1,
      dependentCount: 2,
      commentCount: 3
    })
  })

  it('maps the design, acceptance_criteria, and notes body slots', () => {
    const issue = normalizeBeadsIssue({
      ...RAW_BD_ITEM,
      design: 'Adapter over the existing provider union',
      acceptance_criteria: '- [ ] lists render\n- [ ] status writes back',
      notes: 'Probed against bd 1.1.2'
    })
    expect(issue?.design).toBe('Adapter over the existing provider union')
    expect(issue?.acceptanceCriteria).toBe('- [ ] lists render\n- [ ] status writes back')
    expect(issue?.notes).toBe('Probed against bd 1.1.2')
  })

  it('omits empty-string body slots like bd omits absent ones', () => {
    const issue = normalizeBeadsIssue({ ...RAW_BD_ITEM, design: '', notes: 42 })
    expect(issue).not.toHaveProperty('design')
    expect(issue).not.toHaveProperty('acceptanceCriteria')
    expect(issue).not.toHaveProperty('notes')
  })

  it('never maps owner (the creator) to assignee', () => {
    const issue = normalizeBeadsIssue({ ...RAW_BD_ITEM, assignee: undefined })
    expect(issue?.assignee).toBeUndefined()
    expect(issue).not.toHaveProperty('assignee')
  })

  it('treats absent optionals as empty', () => {
    const issue = normalizeBeadsIssue({
      id: 'beads-probe-b2',
      title: 'Bare issue',
      status: 'open',
      priority: 0,
      issue_type: 'task',
      owner: 'creator@example.com',
      created_at: '2026-08-01T10:00:00Z',
      updated_at: '2026-08-01T10:00:00Z',
      dependency_count: 0,
      dependent_count: 0,
      comment_count: 0
    })
    expect(issue).toEqual({
      id: 'beads-probe-b2',
      title: 'Bare issue',
      status: 'open',
      priority: 0,
      issueType: 'task',
      labels: [],
      createdAt: '2026-08-01T10:00:00Z',
      updatedAt: '2026-08-01T10:00:00Z',
      dependencyCount: 0,
      dependentCount: 0,
      commentCount: 0
    })
    expect(issue).not.toHaveProperty('description')
    expect(issue).not.toHaveProperty('closedAt')
  })

  it('preserves closed_at and hierarchical child ids', () => {
    const issue = normalizeBeadsIssue({
      ...RAW_BD_ITEM,
      id: 'beads-probe-ay8.1',
      status: 'closed',
      closed_at: '2026-08-11T00:00:00Z'
    })
    expect(issue?.id).toBe('beads-probe-ay8.1')
    expect(issue?.status).toBe('closed')
    expect(issue?.closedAt).toBe('2026-08-11T00:00:00Z')
  })

  it('falls back to open for unknown statuses and task for missing issue_type', () => {
    const issue = normalizeBeadsIssue({
      ...RAW_BD_ITEM,
      status: 'triaged',
      issue_type: undefined
    })
    expect(issue?.status).toBe('open')
    expect(issue?.issueType).toBe('task')
  })

  it('defaults malformed counts, priority, and labels safely', () => {
    const issue = normalizeBeadsIssue({
      ...RAW_BD_ITEM,
      priority: 'high',
      labels: ['ok', 42, null],
      dependency_count: Number.NaN,
      dependent_count: '3',
      comment_count: undefined
    })
    expect(issue?.priority).toBe(0)
    expect(issue?.labels).toEqual(['ok'])
    expect(issue?.dependencyCount).toBe(0)
    expect(issue?.dependentCount).toBe(0)
    expect(issue?.commentCount).toBe(0)
  })

  it('returns null for garbage input', () => {
    expect(normalizeBeadsIssue(null)).toBeNull()
    expect(normalizeBeadsIssue(undefined)).toBeNull()
    expect(normalizeBeadsIssue('beads-probe-ay8')).toBeNull()
    expect(normalizeBeadsIssue(42)).toBeNull()
    expect(normalizeBeadsIssue([])).toBeNull()
    expect(normalizeBeadsIssue({ error: 'no issues found matching the provided IDs' })).toBeNull()
  })

  it('requires id, title, created_at, and updated_at', () => {
    expect(normalizeBeadsIssue({ ...RAW_BD_ITEM, id: undefined })).toBeNull()
    expect(normalizeBeadsIssue({ ...RAW_BD_ITEM, id: '' })).toBeNull()
    expect(normalizeBeadsIssue({ ...RAW_BD_ITEM, title: 7 })).toBeNull()
    expect(normalizeBeadsIssue({ ...RAW_BD_ITEM, created_at: undefined })).toBeNull()
    expect(normalizeBeadsIssue({ ...RAW_BD_ITEM, updated_at: '' })).toBeNull()
  })

  it('ignores unknown fields instead of forwarding them', () => {
    const issue = normalizeBeadsIssue({ ...RAW_BD_ITEM, future_field: 'x' })
    expect(issue).not.toHaveProperty('future_field')
    expect(issue).not.toHaveProperty('owner')
    expect(issue).not.toHaveProperty('created_by')
    expect(issue).not.toHaveProperty('started_at')
  })
})

describe('normalizeBeadsIssueDetails', () => {
  it('maps relations, comments, and parent from the probed bd show shape', () => {
    const details = normalizeBeadsIssueDetails({
      ...RAW_BD_ITEM,
      parent: 'beads-probe-parent',
      dependencies: [
        { ...RAW_BD_ITEM, id: 'beads-probe-parent', dependency_type: 'parent-child' },
        { ...RAW_BD_ITEM, id: 'beads-probe-blocker', dependency_type: 'blocks' }
      ],
      dependents: [{ ...RAW_BD_ITEM, id: 'beads-probe-child', dependency_type: 'parent-child' }],
      comments: [
        {
          id: '019ff503-3b1c-749b-a815-fc16b80fc380',
          issue_id: 'beads-probe-ay8',
          author: 'ada',
          text: 'first comment',
          created_at: '2026-08-11T00:00:00Z'
        }
      ]
    })
    expect(details?.issue.id).toBe('beads-probe-ay8')
    expect(details?.parent).toBe('beads-probe-parent')
    expect(details?.dependencies.map((d) => d.dependencyType)).toEqual(['parent-child', 'blocks'])
    expect(details?.dependents.map((d) => d.id)).toEqual(['beads-probe-child'])
    expect(details?.comments).toEqual([
      {
        id: '019ff503-3b1c-749b-a815-fc16b80fc380',
        author: 'ada',
        text: 'first comment',
        createdAt: '2026-08-11T00:00:00Z'
      }
    ])
  })

  it('tolerates absent arrays and parent (bd omits them when empty or comments_omitted)', () => {
    expect(normalizeBeadsIssueDetails(RAW_BD_ITEM)).toEqual({
      issue: normalizeBeadsIssue(RAW_BD_ITEM),
      parent: null,
      dependencies: [],
      dependents: [],
      comments: []
    })
  })

  it('drops garbage relation and comment entries instead of failing', () => {
    const details = normalizeBeadsIssueDetails({
      ...RAW_BD_ITEM,
      dependencies: [null, 'junk', { id: 'no-title-or-dates' }],
      comments: [null, { id: 'c-1', text: 7, created_at: 'x' }, { author: 'ada' }]
    })
    expect(details?.dependencies).toEqual([])
    expect(details?.comments).toEqual([])
  })

  it('returns null when the issue itself is garbage', () => {
    expect(normalizeBeadsIssueDetails(null)).toBeNull()
    expect(normalizeBeadsIssueDetails({ comments: [] })).toBeNull()
  })
})

describe('normalizeBeadsIssueRelation', () => {
  it('passes unknown dependency types through and defaults absent ones to blocks', () => {
    expect(
      normalizeBeadsIssueRelation({ ...RAW_BD_ITEM, dependency_type: 'future-type' })
        ?.dependencyType
    ).toBe('future-type')
    expect(normalizeBeadsIssueRelation(RAW_BD_ITEM)?.dependencyType).toBe('blocks')
  })
})

describe('normalizeBeadsIssueComment', () => {
  it('stringifies numeric ids and defaults a missing author', () => {
    expect(
      normalizeBeadsIssueComment({ id: 7, text: 'hi', created_at: '2026-08-11T00:00:00Z' })
    ).toEqual({ id: '7', author: '', text: 'hi', createdAt: '2026-08-11T00:00:00Z' })
  })
})
