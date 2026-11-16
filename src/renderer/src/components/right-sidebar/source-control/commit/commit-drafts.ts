import type { SourceControlViewMode } from '../../../../../../shared/ui-chrome-types'

export function normalizeSourceControlViewMode(value: unknown): SourceControlViewMode {
  return value === 'tree' || value === 'list' ? value : 'list'
}
