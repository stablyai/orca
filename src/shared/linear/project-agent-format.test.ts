import { describe, expect, it } from 'vitest'

import type {
  LinearProjectLabelsResult,
  LinearProjectShowResult,
  LinearProjectStatusesResult
} from './project-agent-access'
import {
  LINEAR_PROJECT_STATUSES_NOUN,
  formatLinearProjectLabels,
  formatLinearProjectShow,
  formatLinearProjectStatuses,
  linearProjectFanoutWarningLines
} from './project-agent-format'

function boundedString(value: string) {
  return { value, truncated: false, chars: value.length, sha256: 'c'.repeat(64) }
}

function collection<TItem extends { id: string }>(items: TItem[], total = items.length) {
  return {
    items,
    returned: items.length,
    total,
    truncated: items.length < total,
    sha256: 'd'.repeat(64)
  }
}

const SHOW_FIXTURE = {
  project: {
    id: 'project-1',
    name: '\u001b[31mLaunch Q3\u001b[0m',
    slugId: 'launch-q3',
    url: 'https://linear.app/acme/project/launch-q3-1a2b3c',
    description: boundedString('Ship it\nfast'),
    content: { value: null, truncated: false, chars: 0, sha256: '' },
    status: { id: 'status-1', name: 'In Progress', type: 'started', color: '#00ff00' },
    lead: { id: 'user-1', displayName: 'Ada', avatarUrl: null },
    members: collection([{ id: 'user-1', displayName: 'Ada', avatarUrl: null }]),
    teams: collection([{ id: 'team-1', name: 'Engineering', key: 'ENG' }], 3),
    labels: collection([
      { id: 'label-1', name: 'Launch', color: '#ff0000', parent: { id: 'g1', name: 'Phase' } }
    ]),
    priority: 2,
    startDate: '2026-01-01',
    targetDate: null,
    color: '#112233',
    icon: null,
    health: 'onTrack',
    healthUpdatedAt: '2026-02-01T00:00:00.000Z'
  },
  updates: [
    {
      id: 'update-1',
      body: boundedString('Shipped the beta\nSecond line'),
      health: 'atRisk',
      url: 'https://linear.app/acme/project/launch-q3-1a2b3c#update-1',
      isDiffHidden: false,
      isStale: true,
      createdAt: '2026-06-01T00:00:00.000Z',
      updatedAt: '2026-06-01T00:00:00.000Z',
      editedAt: null,
      user: { id: 'user-1', displayName: 'Ada', avatarUrl: null }
    }
  ],
  meta: {
    workspaceId: 'workspace-1',
    workspaceName: 'Acme',
    resolvedBy: 'slug',
    updates: { returned: 1, cap: 5, capReached: true, hasMore: true }
  }
} as LinearProjectShowResult

const STATUSES_FIXTURE = {
  statuses: [
    {
      id: 'status-1',
      name: 'In Progress',
      type: 'started',
      color: '#00ff00',
      workspaceId: 'workspace-1',
      workspaceName: 'Acme'
    }
  ],
  meta: {
    limit: 20,
    returned: 1,
    partial: true,
    workspaceResults: [
      { workspace: { id: 'workspace-1', name: 'Acme' }, returned: 1, hasMore: true }
    ],
    workspaceErrors: [
      {
        workspace: { id: 'workspace-2', name: 'Globex' },
        code: 'linear_rate_limited',
        message: 'Rate limited'
      }
    ]
  }
} as LinearProjectStatusesResult

const LABELS_FIXTURE = {
  labels: [
    {
      id: 'label-1',
      name: 'Launch',
      color: '#ff0000',
      parent: { id: 'g1', name: 'Phase' },
      workspaceId: 'workspace-1',
      workspaceName: 'Acme'
    }
  ],
  meta: {
    limit: 20,
    returned: 1,
    partial: false,
    workspaceResults: [
      { workspace: { id: 'workspace-1', name: 'Acme' }, returned: 1, hasMore: false }
    ],
    workspaceErrors: []
  }
} as LinearProjectLabelsResult

// Why: the golden text both the local CLI and the SSH shim must print; drift here is drift between them.
describe('shared project rendering', () => {
  it('renders the canonical project show block', () => {
    expect(formatLinearProjectShow(SHOW_FIXTURE)).toBe(
      [
        'Launch Q3 (launch-q3)',
        'URL: https://linear.app/acme/project/launch-q3-1a2b3c',
        'Workspace: Acme (workspace-1) via slug',
        'Status: In Progress (started)',
        'Health: on-track updated 2026-02-01T00:00:00.000Z',
        'Lead: Ada',
        'Priority: high',
        'Dates: 2026-01-01 -> none',
        'Color: #112233  Icon: none',
        `Teams: 3 (showing 1) - ENG Engineering sha256 ${'d'.repeat(64)}`,
        `Members: 1 - Ada sha256 ${'d'.repeat(64)}`,
        `Labels: 1 - Phase/Launch sha256 ${'d'.repeat(64)}`,
        `Description: 12 chars sha256 ${'c'.repeat(64)}`,
        '  Ship it fast',
        'Content: none',
        'Updates: 1 (more available) (capped at 5)',
        '  2026-06-01T00:00:00.000Z Ada at-risk (stale)',
        `    28 chars sha256 ${'c'.repeat(64)}`,
        '    Shipped the beta Second line'
      ].join('\n')
    )
  })

  it('strips terminal control sequences from show output', () => {
    expect(formatLinearProjectShow(SHOW_FIXTURE)).not.toContain('\u001b')
  })

  it('groups a label under its parent and keeps the workspace column', () => {
    expect(formatLinearProjectLabels(LABELS_FIXTURE)).toBe(
      `${'Phase/Launch'.padEnd(34)} ${'Acme'.padEnd(20)} label-1`
    )
  })

  it('reports empty metadata results', () => {
    expect(formatLinearProjectStatuses({ ...STATUSES_FIXTURE, statuses: [] })).toBe(
      'No Linear project statuses found.'
    )
    expect(formatLinearProjectLabels({ ...LABELS_FIXTURE, labels: [] })).toBe(
      'No Linear project labels found.'
    )
  })

  it('orders status columns name, type, workspace, id', () => {
    expect(formatLinearProjectStatuses(STATUSES_FIXTURE)).toBe(
      `${'In Progress'.padEnd(28)} ${'started'.padEnd(10)} ${'Acme'.padEnd(20)} status-1`
    )
  })

  it('emits truncation, workspace-error and partial warning lines in order', () => {
    expect(
      linearProjectFanoutWarningLines(STATUSES_FIXTURE.meta, LINEAR_PROJECT_STATUSES_NOUN)
    ).toEqual([
      'warning: Acme has more Linear project statuses than the 20 shown; narrow with --query or raise --limit',
      'warning: Globex unavailable for Linear project statuses: Rate limited',
      'warning: Linear project statuses results are partial across workspaces'
    ])
  })
})
