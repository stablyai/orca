import { afterEach, describe, expect, it, vi } from 'vitest'
import { Document } from 'yaml'
import { parseOrcaYaml } from './orca-yaml'

afterEach(() => vi.restoreAllMocks())

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
    const tabs = Array.from(
      { length: 40 },
      (_, index) => `  - <<: *shared\n    title: tab${index}`
    ).join('\n')

    const parsed = parseOrcaYaml(`
shared: &shared
  command: pnpm dev
defaultTabs:
${tabs}
`)
    expect(parsed).toMatchObject({
      defaultTabs: expect.arrayContaining([{ title: 'tab39', command: 'pnpm dev' }])
    })
    expect(parsed?.defaultTabs).toEqual(
      Array.from({ length: 40 }, (_, index) => ({ title: `tab${index}`, command: 'pnpm dev' }))
    )
  })

  it('rejects nested aliases that expand exponentially', () => {
    let source = 'a0: &a0 [x, x, x, x, x, x, x, x, x]\n'
    for (let level = 1; level <= 8; level += 1) {
      source += `a${level}: &a${level} [${Array(9)
        .fill(`*a${level - 1}`)
        .join(', ')}]\n`
    }

    expect(parseOrcaYaml(`${source}scripts:\n  setup: *a8\n`)).toBeNull()
  })
})

it('rejects repeated flat map merges before conversion', () => {
  const toJS = vi.spyOn(Document.prototype, 'toJS')
  const fields = Array.from({ length: 2000 }, (_, index) => `  ignored${index}: x`).join('\n')
  const tabs = Array.from({ length: 96 }, () => '  - <<: *base').join('\n')
  expect(
    parseOrcaYaml(`base: &base\n  command: pnpm dev\n${fields}\ndefaultTabs:\n${tabs}\n`)
  ).toBeNull()
  expect(toJS).not.toHaveBeenCalled()
})

it('bounds repeated conversion of nested values inside merge sources', () => {
  const toJS = vi.spyOn(Document.prototype, 'toJS')
  const fields = Array.from({ length: 1100 }, (_, index) => `    ignored${index}: x`).join('\n')
  const tabs = Array.from({ length: 256 }, () => '  - <<: *base').join('\n')
  expect(
    parseOrcaYaml(`base: &base\n  command: pnpm dev\n  nested:\n${fields}\ndefaultTabs:\n${tabs}\n`)
  ).toBeNull()
  expect(toJS).not.toHaveBeenCalled()
})

it('rejects nested merge sequences before their expansion is converted', () => {
  const toJS = vi.spyOn(Document.prototype, 'toJS')
  let source = 'base0: &base0 { command: pnpm dev }\n'
  for (let level = 1; level <= 10; level += 1) {
    source += `base${level}: &base${level} { <<: [${Array(4)
      .fill(`*base${level - 1}`)
      .join(', ')}] }\n`
  }
  expect(parseOrcaYaml(`${source}defaultTabs: [{ <<: *base10 }]`)).toBeNull()
  expect(toJS).not.toHaveBeenCalled()
})

it('rejects a cyclic merge before conversion', () => {
  const toJS = vi.spyOn(Document.prototype, 'toJS')
  expect(parseOrcaYaml('base: &base { <<: *base, command: pnpm dev }')).toBeNull()
  expect(toJS).not.toHaveBeenCalled()
})

it('preserves merge precedence, literal merge keys, and redefined anchors', () => {
  expect(
    parseOrcaYaml(`
first: &defaults { command: first }
second: &other { command: second, title: shared }
defaultTabs:
  - <<: [*defaults, *other]
    title: explicit
  - "<<": *other
    command: literal
replacement: &defaults { command: replacement }
more: &more { <<: *defaults }
scripts:
  setup: ready
`)
  ).toMatchObject({
    defaultTabs: [{ title: 'explicit', command: 'first' }, { command: 'literal' }]
  })
  expect(
    parseOrcaYaml(`
first: &defaults { command: first }
second: &defaults { command: second }
defaultTabs:
  - <<: *defaults
`)
  ).toMatchObject({ defaultTabs: [{ command: 'second' }] })
})

it.each(['omap', 'pairs'])('bounds merge descendants inside explicit !!%s pairs', (tag) => {
  const toJS = vi.spyOn(Document.prototype, 'toJS').mockImplementation(() => {
    throw new Error('Over-budget YAML must not reach conversion')
  })
  let source = `hidden: !!${tag}\n  - base0: &base0 { command: pnpm dev }\n`
  for (let level = 1; level <= 10; level += 1) {
    source += `  - base${level}: &base${level} { <<: [${Array(4)
      .fill(`*base${level - 1}`)
      .join(', ')}] }\n`
  }
  expect(parseOrcaYaml(`${source}scripts: { setup: pnpm install }\n`)).toBeNull()
  expect(toJS).not.toHaveBeenCalled()
})

it('bounds merge keys used directly as explicit !!pairs items', () => {
  const toJS = vi.spyOn(Document.prototype, 'toJS').mockImplementation(() => {
    throw new Error('Over-budget YAML must not reach conversion')
  })
  const fields = Array.from({ length: 2000 }, (_, index) => `  ignored${index}: x`).join('\n')
  const pairs = Array.from({ length: 96 }, () => '  - <<: *base').join('\n')
  const source = `base: &base\n  command: pnpm dev\n${fields}\nhidden: !!pairs\n${pairs}\nscripts: { setup: pnpm install }\n`
  expect(parseOrcaYaml(source)).toBeNull()
  expect(toJS).not.toHaveBeenCalled()
})

it.each(['omap', 'pairs'])('preserves a small explicit !!%s value', (tag) => {
  expect(
    parseOrcaYaml(
      `hidden: !!${tag}\n  - defaults: { command: pnpm dev }\nscripts: { setup: pnpm install }\n`
    )
  ).toMatchObject({ scripts: { setup: 'pnpm install' } })
})
