import { describe, expect, it } from 'vitest'

import type { LinearProjectSummary } from '../../../shared/linear/project-types'
import {
  linearProjectDateLabel,
  linearProjectMetadataLabels,
  linearProjectPriorityLabel,
  linearProjectProgressPercent,
  linearProjectUnknownText,
  linearProjectWorkspaceLabel
} from './linear-project-presentation'

function project(progress?: number | null): LinearProjectSummary {
  return { id: 'project-1', name: 'Compiler', progress }
}

describe('Linear project presentation', () => {
  it('keeps optional mixed-version metadata permissive', () => {
    expect(linearProjectUnknownText({ displayName: 'Ada' })).toBe('Ada')
    expect(linearProjectUnknownText({ body: ' Shipped ' })).toBe('Shipped')
    expect(linearProjectUnknownText({ unknown: 'value' })).toBeNull()
    expect(linearProjectUnknownText(undefined)).toBeNull()
    expect(linearProjectMetadataLabels([{ name: 'A' }, null, { title: 'B' }], 1)).toEqual(['A'])
  })

  it('preserves date, priority, progress, and workspace fallbacks', () => {
    expect(linearProjectDateLabel(null)).toBe('None')
    expect(linearProjectDateLabel('not-a-date')).toBe('not-a-date')
    expect(linearProjectPriorityLabel(2, 'Urgent')).toBe('Urgent')
    expect(linearProjectPriorityLabel(0, null)).toBe('None')
    expect(linearProjectPriorityLabel(3, null)).toBe('P3')
    expect(linearProjectProgressPercent(project(0.42))).toBe(42)
    expect(linearProjectProgressPercent(project(42.4))).toBe(42)
    expect(linearProjectProgressPercent(project(Number.NaN))).toBeNull()
    expect(linearProjectWorkspaceLabel('all', 'Acme')).toBe('Acme')
    expect(linearProjectWorkspaceLabel('workspace-1', 'Acme')).toBeNull()
  })
})
