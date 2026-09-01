import { createHash } from 'node:crypto'
// TypeScript 7 is a native CLI; AST tests still need the legacy JavaScript API.
import ts from 'typescript-api'

export type HookContractFact = {
  dependencies: string[] | null
  name: string
}

type HookDefinition = {
  body: ts.Node
  sourceFile: ts.SourceFile
}

export type HookSource = {
  relativePath: string
  source: string
}

export type HookDefinitions = ReadonlyMap<string, HookDefinition>

function readFunctionName(node: ts.Node): string | null {
  if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) && node.name) {
    return node.name.text
  }
  if (
    ts.isArrowFunction(node) &&
    ts.isVariableDeclaration(node.parent) &&
    ts.isIdentifier(node.parent.name)
  ) {
    return node.parent.name.text
  }
  return null
}

function readHookName(node: ts.CallExpression): string | null {
  if (ts.isIdentifier(node.expression) && /^use[A-Z]/.test(node.expression.text)) {
    return node.expression.text
  }
  if (
    ts.isPropertyAccessExpression(node.expression) &&
    /^use[A-Z]/.test(node.expression.name.text)
  ) {
    return node.expression.name.text
  }
  return null
}

function normalize(node: ts.Node, sourceFile: ts.SourceFile): string {
  return node
    .getText(sourceFile)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
    .replace(/\s+/g, '')
}

export function readHookDefinitions(
  sources: readonly HookSource[],
  includesDefinition: (name: string) => boolean
): HookDefinitions {
  const definitions = new Map<string, HookDefinition>()
  for (const { relativePath, source } of sources) {
    const sourceFile = ts.createSourceFile(
      relativePath,
      source,
      ts.ScriptTarget.Latest,
      true,
      relativePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
    )
    const visit = (node: ts.Node): void => {
      if (
        (ts.isFunctionDeclaration(node) ||
          ts.isFunctionExpression(node) ||
          ts.isArrowFunction(node)) &&
        node.body
      ) {
        const name = readFunctionName(node)
        if (name && includesDefinition(name)) {
          definitions.set(name, { body: node.body, sourceFile })
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sourceFile)
  }
  return definitions
}

export function readFlattenedHookFacts(
  definitions: HookDefinitions,
  rootName: string
): HookContractFact[] {
  const flatten = (name: string, active: ReadonlySet<string>): HookContractFact[] => {
    const definition = definitions.get(name)
    if (!definition || active.has(name)) {
      throw new Error(`Invalid hook stage: ${name}`)
    }
    const facts: HookContractFact[] = []
    const nextActive = new Set([...active, name])
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const hookName = readHookName(node)
        if (hookName) {
          if (definitions.has(hookName)) {
            facts.push(...flatten(hookName, nextActive))
          } else {
            const dependencyArray = [...node.arguments]
              .toReversed()
              .find((argument) => ts.isArrayLiteralExpression(argument))
            facts.push({
              dependencies: dependencyArray
                ? [...dependencyArray.elements].map((element) =>
                    normalize(element, definition.sourceFile)
                  )
                : null,
              name: hookName
            })
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(definition.body)
    return facts
  }

  return flatten(rootName, new Set())
}

export function hashContract(values: readonly string[]): string {
  return createHash('sha256').update(values.join('\n')).digest('hex')
}

export function readDependencyContract(facts: readonly HookContractFact[]): string[] {
  return facts.flatMap(({ dependencies, name }) =>
    dependencies === null ? [] : [`${name}|[${dependencies.join(',')}]`]
  )
}

export function projectDependencyContract(
  facts: readonly HookContractFact[],
  allowedAdditions: Readonly<Record<number, readonly string[]>>
): string[] {
  const dependencyFacts = facts.filter(
    (fact): fact is HookContractFact & { dependencies: string[] } => fact.dependencies !== null
  )
  for (const ordinal of Object.keys(allowedAdditions).map(Number)) {
    if (!Number.isInteger(ordinal) || ordinal < 0 || ordinal >= dependencyFacts.length) {
      throw new Error(`Invalid dependency-array ordinal: ${ordinal}`)
    }
  }
  return dependencyFacts.map(({ dependencies, name }, ordinal) => {
    const projected = [...dependencies]
    for (const addition of allowedAdditions[ordinal] ?? []) {
      const index = projected.indexOf(addition)
      if (index === -1) {
        throw new Error(`Missing allowed dependency addition at ${ordinal}: ${addition}`)
      }
      projected.splice(index, 1)
    }
    return `${name}|[${projected.join(',')}]`
  })
}
