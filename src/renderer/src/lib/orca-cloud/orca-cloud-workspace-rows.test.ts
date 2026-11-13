import { describe, expect, it } from 'vitest'
import type { CloudWorkspaceSnapshot } from './orca-cloud-workspace-store'
import { isCloudStatusRow, isPairedCloudStatusRow } from './orca-cloud-workspace-rows'

const snapshot = (ids: string[], paired: Record<string, string>): CloudWorkspaceSnapshot =>
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the checks read only ids and paired.
  ({ ids: new Set(ids), paired }) as unknown as CloudWorkspaceSnapshot

describe('PAIRED-CHROME row checks', () => {
  it('a status row is an owned or a paired cloud workspace', () => {
    const s = snapshot(['owned'], { paired: 'env-1' })
    expect(isCloudStatusRow(s, 'owned')).toBe(true)
    expect(isCloudStatusRow(s, 'paired')).toBe(true)
    expect(isCloudStatusRow(s, 'local')).toBe(false)
  })

  it('only a row this desktop does not own counts as paired (and never an inherited key)', () => {
    const s = snapshot(['both'], { paired: 'env-1', both: 'env-2' })
    expect(isPairedCloudStatusRow(s, 'paired')).toBe(true)
    expect(isPairedCloudStatusRow(s, 'both')).toBe(false)
    expect(isPairedCloudStatusRow(s, 'toString')).toBe(false)
    expect(isCloudStatusRow(s, 'toString')).toBe(false)
  })
})
