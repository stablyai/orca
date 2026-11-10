import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  secretRequestNameRefusal,
  WORKER_RESERVED_SECRET_NAMES,
  WORKER_RESERVED_SECRET_PREFIXES
} from './secret-request-names'

const WORKER_SECRETS = fileURLToPath(
  new URL('../../cloud/apps/sandbox-control/src/secrets.ts', import.meta.url)
)

function quotedStrings(text: string): string[] {
  return [...text.matchAll(/'([A-Z0-9_]+)'/g)].map((match) => match[1])
}

describe('secret request names match the control plane', () => {
  const source = readFileSync(WORKER_SECRETS, 'utf8')

  it('uses the Worker reserved names and prefixes', () => {
    const names = source.match(/const RESERVED_NAMES[^=]*= new Set\(\[([\s\S]*?)\]\)/)?.[1]
    const prefixes = source.match(/const RESERVED_PREFIXES = \[([^\]]*)\]/)?.[1]
    expect(names, 'RESERVED_NAMES not found in the Worker').toBeTruthy()
    expect(prefixes, 'RESERVED_PREFIXES not found in the Worker').toBeTruthy()
    expect(new Set(quotedStrings(names ?? ''))).toEqual(WORKER_RESERVED_SECRET_NAMES)
    expect(quotedStrings(prefixes ?? '')).toEqual([...WORKER_RESERVED_SECRET_PREFIXES])
  })

  it('uses the Worker name pattern and length', () => {
    expect(source).toContain('const NAME = /^[A-Z_][A-Z0-9_]*$/')
    expect(source).toContain('const MAX_NAME_LENGTH = 128')
    expect(secretRequestNameRefusal('A'.repeat(128))).toBeNull()
    expect(secretRequestNameRefusal('_PRIVATE_1')).toBeNull()
  })
})
