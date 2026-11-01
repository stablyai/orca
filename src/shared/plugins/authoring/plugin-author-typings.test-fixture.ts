import path from 'node:path'
import ts from 'typescript-api'

const RESOURCES = path.resolve(__dirname, '../../../../resources/plugins')

/** The files `orca plugin types` copies, as checked in. */
export const AUTHOR_TYPINGS_FILES = [
  path.join(RESOURCES, 'declarative', 'orca.d.ts'),
  path.join(RESOURCES, 'declarative', 'orca-components.d.ts'),
  path.join(RESOURCES, 'declarative', 'orca-components-layout.d.ts'),
  path.join(RESOURCES, 'declarative', 'orca-components-data.d.ts'),
  path.join(RESOURCES, 'types', 'orca-host.d.ts'),
  path.join(RESOURCES, 'types', 'orca-frame.d.ts'),
  path.join(RESOURCES, 'types', 'orca-worker.d.ts'),
  path.join(RESOURCES, 'types', 'orca-services.d.ts'),
  path.join(RESOURCES, 'types', 'orca-testing.d.ts')
]

// Mirrors the tsconfig `orca plugin types` writes (plugin-type-files.ts).
const OPTIONS: ts.CompilerOptions = {
  strict: true,
  noEmit: true,
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  allowImportingTsExtensions: true,
  isolatedModules: true,
  jsx: ts.JsxEmit.ReactJSX,
  jsxImportSource: 'orca',
  lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
  types: []
}

/** A program over the author typings plus in-memory plugin sources keyed by file name. */
export function authorTypingsProgram(sources: Record<string, string> = {}): ts.Program {
  const root = path.join(RESOURCES, '__plugin__')
  const virtual = new Map(
    Object.entries(sources).map(([name, text]) => [path.join(root, name), text])
  )
  const host = ts.createCompilerHost(OPTIONS)
  const readFile = host.readFile.bind(host)
  const getSourceFile = host.getSourceFile.bind(host)
  host.readFile = (file) => virtual.get(file) ?? readFile(file)
  host.fileExists = (file) => virtual.has(file) || ts.sys.fileExists(file)
  // Virtual folders exist too, so relative imports between the samples resolve.
  host.directoryExists = (dir) =>
    [...virtual.keys()].some((file) => file.startsWith(dir + path.sep)) ||
    ts.sys.directoryExists(dir)
  host.getSourceFile = (file, language, ...rest) => {
    const text = virtual.get(file)
    return text === undefined
      ? getSourceFile(file, language, ...rest)
      : ts.createSourceFile(file, text, language)
  }
  return ts.createProgram([...AUTHOR_TYPINGS_FILES, ...virtual.keys()], OPTIONS, host)
}

/** `file:line message` for every diagnostic, so a failure names the offending sample line. */
export function authorTypingsDiagnostics(program: ts.Program): string[] {
  return ts.getPreEmitDiagnostics(program).map((diagnostic) => {
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')
    if (!diagnostic.file || diagnostic.start === undefined) {
      return message
    }
    const { line } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
    return `${path.basename(diagnostic.file.fileName)}:${line + 1} ${message}`
  })
}

/** Object members become nested shapes, callables `'function'`, everything else `'value'`. */
export type TypingsShape = 'function' | 'value' | { [key: string]: TypingsShape }

/** The member tree of type `typeName` exported by `declare module '<moduleName>'`; optional
 *  members are listed under `optional` so a runtime may omit them. */
export function exportedTypeShape(
  moduleName: string,
  typeName: string
): { shape: TypingsShape; optional: string[] } {
  const checker = authorTypingsProgram().getTypeChecker()
  const module = checker.getAmbientModules().find((symbol) => symbol.name === `"${moduleName}"`)
  const exported = module && checker.getExportsOfModule(module).find((s) => s.name === typeName)
  if (!exported) {
    throw new Error(`no ${typeName} in module '${moduleName}'`)
  }
  const optional: string[] = []
  const shapeOf = (type: ts.Type, prefix: string): TypingsShape => {
    const target = checker.getNonNullableType(type)
    if (target.getCallSignatures().length > 0) {
      return 'function'
    }
    if (!(target.flags & ts.TypeFlags.Object) || checker.isArrayLikeType(target)) {
      return 'value'
    }
    const shape: Record<string, TypingsShape> = {}
    for (const property of target.getProperties()) {
      const name = `${prefix}${property.name}`
      if (property.flags & ts.SymbolFlags.Optional) {
        optional.push(name)
      }
      shape[property.name] = shapeOf(checker.getTypeOfSymbol(property), `${name}.`)
    }
    return shape
  }
  return { shape: shapeOf(checker.getDeclaredTypeOfSymbol(exported), ''), optional }
}

/** The same tree for a live API object, walking getters and frozen objects alike. */
export function runtimeShape(value: unknown): TypingsShape {
  if (typeof value === 'function') {
    return 'function'
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return 'value'
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, member]) => [key, runtimeShape(member)])
  )
}
