import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveKiroHomeDir } from './kiro-home'

describe('resolveKiroHomeDir', () => {
  it('ignores a relative KIRO_HOME, which would resolve against Orca’s cwd', () => {
    expect(resolveKiroHomeDir({ KIRO_HOME: 'relative/kiro' })).toBe(join(homedir(), '.kiro'))
  })
})
