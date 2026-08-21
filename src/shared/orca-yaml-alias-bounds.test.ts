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

  it('keeps reusing one anchor across a realistic tab list', () => {
    // Flat reuse costs anchor size x uses, which the file-size limit already bounds. Rejecting it
    // broke ordinary configs that merge shared defaults into every tab.
    const tabs = Array.from(
      { length: 40 },
      (_, index) => `  - <<: *shared\n    title: tab${index}`
    ).join('\n')

    expect(
      parseOrcaYaml(`
shared: &shared
  command: pnpm dev
defaultTabs:
${tabs}
`)
    ).toMatchObject({
      defaultTabs: expect.arrayContaining([{ title: 'tab39', command: 'pnpm dev' }])
    })
  })

  it('rejects nested aliases that expand exponentially', () => {
    // The parser rejects on uses x subtree-alias-count, so depth is what it catches: this is a few
    // hundred bytes of source that would otherwise materialize millions of nodes.
    let source = 'a0: &a0 [x, x, x, x, x, x, x, x, x]\n'
    for (let level = 1; level <= 8; level += 1) {
      source += `a${level}: &a${level} [${Array(9)
        .fill(`*a${level - 1}`)
        .join(', ')}]\n`
    }

    expect(parseOrcaYaml(`${source}scripts:\n  setup: *a8\n`)).toBeNull()
  })
})
