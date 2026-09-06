import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import type { z } from 'zod'
import {
  MobileWebBridgePageMessageSchema,
  MobileWebBridgeShellMessageSchema
} from './bridge-contract'
import { tolerantMobileWebShellPayload } from './shell-payload-tolerance'

const PAGE_DIR = resolve(__dirname, '..', '..', 'mobile-web', 'src')

/** Every exported schema in every contract module, by export name. */
async function exportedSchemas(): Promise<Map<string, z.ZodType<unknown>>> {
  const schemas = new Map<string, z.ZodType<unknown>>()
  const files = readdirSync(__dirname).filter(
    (name) => name.endsWith('-contract.ts') && !name.includes('.test.')
  )
  for (const file of files) {
    const module = (await import(/* @vite-ignore */ `./${file.slice(0, -3)}`)) as Record<
      string,
      unknown
    >
    for (const [name, value] of Object.entries(module)) {
      if (name.endsWith('Schema') && isSchema(value)) {
        schemas.set(name, value)
      }
    }
  }
  return schemas
}

function isSchema(value: unknown): value is z.ZodType<unknown> {
  return typeof value === 'object' && value !== null && '_zod' in value
}

/**
 * Schema names the page parses in the shell->page direction: the result schema of every one-shot
 * request and the event schema of every subscription. Derived from the page source so a new
 * operation joins the ratchet without anyone remembering to list it.
 */
function shellAuthoredSchemaNames(): Set<string> {
  const names = new Set<string>()
  for (const file of readdirSync(PAGE_DIR).filter(
    (name) => name.endsWith('.ts') && !name.includes('.test.')
  )) {
    const text = readFileSync(join(PAGE_DIR, file), 'utf8')
    for (const match of text.matchAll(
      /\.request(?:<[^(]*>)?\(\s*'[A-Za-z]+',\s*'[A-Za-z0-9]+',([\s\S]{0,400}?)\n\s*\)/g
    )) {
      const schemas = [...match[1]!.matchAll(/\b([A-Za-z0-9_]*Schema)\b/g)].map((name) => name[1]!)
      if (schemas.length === 2) {
        names.add(schemas[1]!)
      }
    }
    for (const match of text.matchAll(/\beventSchema:\s*([A-Za-z0-9_]*Schema)\b/g)) {
      names.add(match[1]!)
    }
  }
  return names
}

/** Object nodes that still reject unknown keys, reached through any `_zod.def` child. */
function strictPaths(schema: z.ZodType<unknown>): string[] {
  const found: string[] = []
  const seen = new Set<unknown>()
  const visit = (node: unknown, path: string): void => {
    if (isSchema(node)) {
      if (seen.has(node)) {
        return
      }
      seen.add(node)
      const def = (node as unknown as { _zod: { def: Record<string, unknown> } })._zod.def
      const catchall = def.catchall
      if (
        def.type === 'object' &&
        isSchema(catchall) &&
        (catchall as unknown as { _zod: { def: { type: string } } })._zod.def.type === 'never'
      ) {
        found.push(path)
      }
      visit(def, path)
      return
    }
    if (Array.isArray(node)) {
      node.forEach((entry, index) => visit(entry, `${path}[${index}]`))
      return
    }
    if (typeof node === 'object' && node !== null) {
      for (const [key, value] of Object.entries(node)) {
        // A `lazy` getter only reveals its subtree when called; no other function in a def is safe
        // to invoke.
        visit(key === 'getter' && typeof value === 'function' ? value() : value, `${path}.${key}`)
      }
    }
  }
  visit(schema, '')
  return found
}

describe('mobile web shell payload tolerance census', () => {
  let schemas: Map<string, z.ZodType<unknown>>
  const derived = shellAuthoredSchemaNames()

  beforeAll(async () => {
    schemas = await exportedSchemas()
  })

  it('derives the shell-authored schema set from the page instead of a hand list', () => {
    expect(schemas.size).toBeGreaterThanOrEqual(300)
    expect(derived.size).toBeGreaterThanOrEqual(100)
    expect([...derived]).toContain('MobileWebSessionSnapshotResultSchema')
    expect([...derived].filter((name) => !schemas.has(name))).toEqual([])
  })

  // Without this the ratchet below could pass by finding nothing at all.
  it('finds the strict nodes the transform is supposed to open', () => {
    expect(
      strictPaths(schemas.get('MobileWebSessionSnapshotResultSchema')!).length
    ).toBeGreaterThan(4)
  })

  // A `.strict()` node anywhere under a shell-authored payload makes one additive field from a
  // newer APK a permanent `invalid_message` on an older page. The transform has to reach all of
  // them, including through a wrapper it does not yet know about.
  it('leaves no strict object under any schema the page parses from the shell', () => {
    const offenders: Record<string, string[]> = {}
    for (const name of [
      ...derived,
      ...[...schemas.keys()].filter((name) => /(Result|Event)Schema$/.test(name))
    ]) {
      const paths = strictPaths(tolerantMobileWebShellPayload(schemas.get(name)!))
      if (paths.length > 0) {
        offenders[name] = paths
      }
    }

    expect(offenders).toEqual({})
  })

  // The envelope is the same hazard one level up: an additive field on `init` from a newer APK
  // used to fail the union, and a dropped `init` costs the page every grant at once.
  it('leaves no strict object under the shell->page envelope', () => {
    expect(strictPaths(MobileWebBridgeShellMessageSchema).length).toBeGreaterThan(8)
    expect(strictPaths(tolerantMobileWebShellPayload(MobileWebBridgeShellMessageSchema))).toEqual(
      []
    )
  })

  it('keeps the page->shell request schemas strict', () => {
    const payloads = [...schemas.keys()].filter((name) => name.endsWith('PayloadSchema'))
    const open = payloads.filter((name) => strictPaths(schemas.get(name)!).length === 0)

    expect(payloads.length).toBeGreaterThanOrEqual(50)
    expect(open.length).toBeLessThan(payloads.length / 2)
    expect(strictPaths(MobileWebBridgePageMessageSchema).length).toBeGreaterThan(4)
  })
})
