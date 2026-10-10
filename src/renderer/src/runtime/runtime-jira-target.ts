import type { RuntimeClientTarget } from './runtime-client-target'
import { rowLessSourceTarget, type RowLessSource } from '@/lib/default-creation-host'

export type RuntimeJiraSettings = RowLessSource

export function getJiraRuntimeTarget(source: RuntimeJiraSettings): RuntimeClientTarget {
  return rowLessSourceTarget(source)
}
