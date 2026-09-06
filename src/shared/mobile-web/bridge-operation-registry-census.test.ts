import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MOBILE_WEB_BRIDGE_OPERATIONS } from './bridge-operation-registry'

const REPO_ROOT = resolve(__dirname, '..', '..', '..')
const PAGE_DIR = join(REPO_ROOT, 'src', 'mobile-web', 'src')
const SHELL_DIR = join(REPO_ROOT, 'mobile', 'src', 'mobile-web')

const registered = new Set(
  Object.entries(MOBILE_WEB_BRIDGE_OPERATIONS).flatMap(([capability, operations]) =>
    Object.keys(operations).map((operation) => `${capability}.${operation}`)
  )
)

function sources(dir: string, keep: (name: string) => boolean): { name: string; text: string }[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.ts') && !name.includes('.test.') && keep(name))
    .map((name) => ({ name, text: readFileSync(join(dir, name), 'utf8') }))
}

describe('mobile web bridge operation registry census', () => {
  it('registers every capability and operation pair a page request client names', () => {
    const files = sources(PAGE_DIR, () => true)
    const named = new Set<string>()
    for (const { text } of files) {
      for (const match of text.matchAll(/\.request\(\s*'([A-Za-z]+)',\s*'([A-Za-z]+)'/g)) {
        named.add(`${match[1]}.${match[2]}`)
      }
    }

    expect(files.length).toBeGreaterThanOrEqual(40)
    expect(named.size).toBeGreaterThanOrEqual(150)
    expect([...named].filter((pair) => !registered.has(pair))).toEqual([])
  })

  // A bare `string` here is how `workspace.creationRetiredNames` shipped unregistered: the helper
  // erased the operation name before the compiler could check it against the registry.
  it('types every page request client operation parameter against the registry', () => {
    const files = sources(PAGE_DIR, (name) => name.endsWith('-request-client.ts'))
    const untyped = files
      .filter(({ text }) => /\boperation\??:\s*string\b/.test(text))
      .map(({ name }) => name)

    expect(files.map(({ name }) => name)).toContain('mobile-web-one-shot-request-client.ts')
    expect(files.length).toBeGreaterThanOrEqual(20)
    expect(untyped).toEqual([])
  })

  // A page client that reaches one operation through two different schema pairs has an arm nobody
  // reviews; a factory rewrite that swaps a schema shows up here as a second pair.
  it('binds every directly named operation to exactly one payload and result schema', () => {
    const pairs = new Map<string, Set<string>>()
    for (const { text } of sources(PAGE_DIR, () => true)) {
      for (const match of text.matchAll(
        /\.request(?:<[^(]*>)?\(\s*'([A-Za-z]+)',\s*'([A-Za-z0-9]+)',([\s\S]{0,400}?)\n\s*\)/g
      )) {
        const schemas = [...match[3]!.matchAll(/\b([A-Za-z0-9_]*Schema)\b/g)].map((name) => name[1])
        const key = `${match[1]}.${match[2]}`
        pairs.set(key, (pairs.get(key) ?? new Set()).add(schemas.join('|')))
      }
    }

    // The shell arm for this one discriminates two payload shapes with safeParse, so the page
    // deliberately reaches it through two contracts. Nothing else may.
    expect(pairs.size).toBeGreaterThanOrEqual(150)
    expect([...pairs].filter(([, schemas]) => schemas.size !== 1).map(([key]) => key)).toEqual([
      'session.capabilities'
    ])
    expect([...pairs.keys()].filter((key) => !registered.has(key))).toEqual([])
    expect(
      [...pairs]
        .filter(([, schemas]) => [...schemas].some((pair) => pair.split('|').length !== 2))
        .map(([key]) => key)
    ).toEqual([])
  })

  // Capability-level routing is proven against the real table in the shell's dispatch census. This
  // covers the step inside an arm: the operation name has to be matched somewhere, not merely
  // quoted, which a stray comment or an unrelated string used to satisfy.
  it('matches every registered operation at a shell dispatch position', () => {
    const shell = sources(SHELL_DIR, (name) => !name.startsWith('mobile-web-production-'))
    const undispatched = [...registered].filter((pair) => {
      const operation = pair.slice(pair.indexOf('.') + 1)
      const patterns = [
        new RegExp(`operation === '${operation}'`),
        new RegExp(`case '${operation}':`),
        new RegExp(`'${operation}'(?=[,\\]])`),
        new RegExp(`^\\s*'${operation}',?$`, 'm'),
        new RegExp(`\\bstartsWith\\('${operation}'\\)`),
        new RegExp(`\\b${operation}:\\s`)
      ]
      return !shell.some(({ text }) => patterns.some((pattern) => pattern.test(text)))
    })

    expect(shell.length).toBeGreaterThanOrEqual(100)
    expect(undispatched).toEqual([])
  })
})
