import { describe, expect, it } from 'vitest'
import { parseOrcaYaml } from './orca-yaml'

describe('orca.yaml alias expansion', () => {
  it('preserves an ordinary shared scalar', () => {
    expect(
      parseOrcaYaml(`
setupCommand: &setupCommand pnpm install
scripts:
  setup: *setupCommand
`)
    ).toMatchObject({ scripts: { setup: 'pnpm install' } })
  })

  it('rejects alias expansion beyond the explicit conversion cap', () => {
    const aliases = Array.from({ length: 21 }, () => '*items').join(', ')

    expect(
      parseOrcaYaml(`
items: &items [one, two]
expanded: [${aliases}]
scripts:
  setup: pnpm install
`)
    ).toBeNull()
  })
})
