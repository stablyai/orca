import { readFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript-api'
import { describe, expect, it } from 'vitest'
import {
  PLUGIN_DECLARATIVE_CATALOG,
  PLUGIN_DECLARATIVE_COMPONENT_NAMES,
  PLUGIN_DECLARATIVE_ICONS,
  PLUGIN_DECLARATIVE_TONES
} from './plugin-declarative-catalog'
import { spliceOrcaHostTypings } from './plugin-declarative-host-typings'
import * as orcaModule from './runtime/orca-module'

const DECLARATIVE = path.resolve(import.meta.dirname, '../../../../resources/plugins/declarative')
const TYPINGS = path.join(DECLARATIVE, 'orca.d.ts')
// The `orca` module spans these files; `orca plugin types` writes them as one.
const FILES = [
  'orca.d.ts',
  'orca-components.d.ts',
  'orca-components-layout.d.ts',
  'orca-components-data.d.ts'
]

function orcaModules(): ts.ModuleBlock[] {
  return FILES.flatMap((file) => {
    const full = path.join(DECLARATIVE, file)
    const source = ts.createSourceFile(
      full,
      readFileSync(full, 'utf8'),
      ts.ScriptTarget.Latest,
      true
    )
    return source.statements.flatMap((statement) =>
      ts.isModuleDeclaration(statement) &&
      ts.isStringLiteral(statement.name) &&
      statement.name.text === 'orca' &&
      statement.body &&
      ts.isModuleBlock(statement.body)
        ? [statement.body]
        : []
    )
  })
}

const aliases = new Map<string, ts.TypeNode>()
const components = new Map<string, string>()
for (const block of orcaModules()) {
  for (const statement of block.statements) {
    if (ts.isTypeAliasDeclaration(statement)) {
      aliases.set(statement.name.text, statement.type)
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        const type = declaration.type
        if (
          ts.isIdentifier(declaration.name) &&
          type &&
          ts.isTypeReferenceNode(type) &&
          type.typeName.getText() === 'OrcaComponent' &&
          type.typeArguments?.[0]
        ) {
          components.set(declaration.name.text, type.typeArguments[0].getText())
        }
      }
    }
  }
}

/** String literals of a union, following local aliases; null when it is not a literal union. */
function literals(node: ts.TypeNode): string[] | null {
  if (ts.isTypeReferenceNode(node)) {
    const target = aliases.get(node.typeName.getText())
    return target ? literals(target) : null
  }
  if (ts.isUnionTypeNode(node)) {
    const parts = node.types.map(literals)
    return parts.every((part) => part !== null) ? parts.flat() : null
  }
  if (ts.isLiteralTypeNode(node) && ts.isStringLiteral(node.literal)) {
    return [node.literal.text]
  }
  return null
}

type Member = { optional: boolean; type: ts.TypeNode | undefined }

/** Members of a props alias such as `WithChildren & { ... }`, plus whether it is a leaf. */
function propsOf(alias: string): { members: Map<string, Member>; leaf: boolean } {
  const node = aliases.get(alias)
  if (!node) {
    throw new Error(`orca.d.ts has no type ${alias}`)
  }
  const parts = ts.isIntersectionTypeNode(node) ? node.types : [node]
  const members = new Map<string, Member>()
  let leaf = false
  for (const part of parts) {
    if (ts.isTypeReferenceNode(part)) {
      leaf ||= part.typeName.getText() === 'Leaf'
    } else if (ts.isTypeLiteralNode(part)) {
      for (const member of part.members) {
        if (ts.isPropertySignature(member) && member.name) {
          members.set(member.name.getText(), {
            optional: member.questionToken !== undefined,
            type: member.type
          })
        }
      }
    }
  }
  return { members, leaf }
}

type ShapeEntry = {
  safeParse(value: unknown): { success: boolean }
  unwrap?: () => unknown
}

function enumOptions(schema: ShapeEntry): string[] | null {
  const inner: unknown = schema.unwrap ? schema.unwrap() : schema
  const options: unknown =
    typeof inner === 'object' && inner !== null && 'options' in inner ? inner.options : undefined
  return Array.isArray(options) && options.every((option) => typeof option === 'string')
    ? options
    : null
}

describe('orca.d.ts matches the catalog', () => {
  it('declares exactly the catalog components', () => {
    expect([...components.keys()].sort()).toEqual([...PLUGIN_DECLARATIVE_COMPONENT_NAMES].sort())
  })

  it.each(PLUGIN_DECLARATIVE_COMPONENT_NAMES)('%s props, requiredness and enums', (name) => {
    const entry = PLUGIN_DECLARATIVE_CATALOG[name]
    const shape: Record<string, ShapeEntry> = entry.props.shape
    const { members, leaf } = propsOf(components.get(name) ?? '')
    expect(leaf).toBe(entry.children === 'none')
    // `$`-props are wire-only (the runtime adds them); authors never write them.
    const authored = Object.entries(shape).filter(([prop]) => !prop.startsWith('$'))
    expect([...members.keys()].sort()).toEqual(authored.map(([prop]) => prop).sort())
    for (const [prop, schema] of authored) {
      const member = members.get(prop)
      expect({ prop, optional: member?.optional }).toEqual({
        prop,
        optional: schema.safeParse(undefined).success
      })
      const options = enumOptions(schema)
      if (options && member?.type) {
        expect({ prop, values: literals(member.type)?.sort() }).toEqual({
          prop,
          values: [...options].sort()
        })
      }
    }
  })

  it('lists the same component names, and generates host methods from the host API table', () => {
    expect(literals(aliases.get('ComponentName')!)?.sort()).toEqual(
      [...PLUGIN_DECLARATIVE_COMPONENT_NAMES].sort()
    )
    const file = readFileSync(TYPINGS, 'utf8')
    expect(spliceOrcaHostTypings(file)).toBe(file)
  })

  it('exports every catalog component from the guest `orca` module, as its own tag', () => {
    const exported: Record<string, unknown> = { ...orcaModule }
    for (const name of PLUGIN_DECLARATIVE_COMPONENT_NAMES) {
      expect({ name, tag: exported[name] }).toEqual({ name, tag: name })
    }
  })

  it('names the same tones and icons', () => {
    expect(literals(aliases.get('Tone')!)?.sort()).toEqual([...PLUGIN_DECLARATIVE_TONES].sort())
    expect(literals(aliases.get('IconName')!)?.sort()).toEqual([...PLUGIN_DECLARATIVE_ICONS].sort())
  })
})
