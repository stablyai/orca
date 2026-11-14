import type * as Monaco from 'monaco-editor'
import type { SearchOptions, SearchResult } from '../../../../shared/code-search-types'

export const PYTHON_LANGUAGE_ID = 'python'

export type PythonDefinitionTarget = {
  filePath: string
  line: number
  column: number
  sameFile: boolean
}

/** The worktree a file belongs to; cross-file lookups need its root to search. */
export type PythonDefinitionWorkspace = {
  worktreeId: string
  runtimeEnvironmentId: string | null
  rootPath: string
}

export type PythonDefinitionHost = {
  searchFiles: (options: SearchOptions) => Promise<SearchResult>
  readFile: (filePath: string) => Promise<string>
  pathExists: (filePath: string) => Promise<boolean>
  resolveWorkspace: (filePath: string) => PythonDefinitionWorkspace | null
  openAndReveal: (target: PythonDefinitionTarget, workspace: PythonDefinitionWorkspace) => void
}

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** A `def` or `class` statement naming the symbol; 1-based line and column. */
export function findPythonDefinitionInText(
  text: string,
  name: string
): { line: number; column: number } | null {
  const lines = text.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const definition = /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/.exec(line)
    if (definition && definition[1] === name) {
      return { line: index + 1, column: line.indexOf(name, definition.index) + 1 }
    }
    const klass = /^\s*class\s+([A-Za-z_]\w*)/.exec(line)
    if (klass && klass[1] === name) {
      return { line: index + 1, column: line.indexOf(name, klass.index) + 1 }
    }
  }
  return null
}

/** The module a `from x import name` statement pulls the symbol from. */
export function findImportedPythonModule(text: string, name: string): string | null {
  const pattern = new RegExp(
    `^\\s*from\\s+([A-Za-z_][\\w.]*)\\s+import\\s+[^\\n]*\\b${escapeRegExp(name)}\\b`,
    'm'
  )
  return pattern.exec(text)?.[1] ?? null
}

/** Ripgrep reports the match start; the name may sit further right on the line. */
function nameColumnOf(lineContent: string, name: string, fallbackColumn: number): number {
  const index = lineContent.indexOf(name)
  return index !== -1 ? index + 1 : fallbackColumn
}

function moduleCandidates(moduleName: string, rootPath: string, currentDir: string): string[] {
  const relative = moduleName.split('.').join('/')
  return [
    `${rootPath}/${relative}.py`,
    `${rootPath}/${relative}/__init__.py`,
    `${currentDir}/${relative}.py`,
    `${currentDir}/${relative}/__init__.py`
  ]
}

function sameDirectoryFirst(
  files: SearchResult['files'],
  currentDir: string
): SearchResult['files'] {
  return [...files].sort((a, b) => {
    const aDir = a.filePath.slice(0, a.filePath.lastIndexOf('/'))
    const bDir = b.filePath.slice(0, b.filePath.lastIndexOf('/'))
    return Number(bDir === currentDir) - Number(aDir === currentDir)
  })
}

async function searchDefinitions(
  host: PythonDefinitionHost,
  rootPath: string,
  name: string,
  includePattern: string
): Promise<SearchResult['files']> {
  const query = `^(async\\s+)?def\\s+${escapeRegExp(name)}\\b|^class\\s+${escapeRegExp(name)}\\b`
  const result = await host.searchFiles({
    query,
    rootPath,
    useRegex: true,
    caseSensitive: true,
    includePattern,
    maxResults: 200
  })
  return result.files ?? []
}

async function searchAssignments(
  host: PythonDefinitionHost,
  rootPath: string,
  name: string,
  includePattern: string
): Promise<SearchResult['files']> {
  const result = await host.searchFiles({
    query: `^\\s*${escapeRegExp(name)}\\s*[:=]`,
    rootPath,
    useRegex: true,
    caseSensitive: true,
    includePattern,
    maxResults: 50
  })
  return result.files ?? []
}

function firstMatchTarget(
  files: SearchResult['files'],
  name: string
): PythonDefinitionTarget | null {
  for (const file of files) {
    for (const match of file.matches ?? []) {
      return {
        filePath: file.filePath,
        line: match.line,
        column: nameColumnOf(match.lineContent ?? '', name, match.column),
        sameFile: false
      }
    }
  }
  return null
}

/** Where the symbol is defined: this file first, then the worktree, then the imported module. */
export async function resolvePythonDefinition(params: {
  text: string
  name: string
  filePath: string
  host: PythonDefinitionHost
}): Promise<PythonDefinitionTarget | null> {
  const { text, name, filePath, host } = params
  const local = findPythonDefinitionInText(text, name)
  if (local) {
    return { filePath, line: local.line, column: local.column, sameFile: true }
  }

  const workspace = host.resolveWorkspace(filePath)
  if (!workspace) {
    return null
  }
  const currentDir = filePath.slice(0, filePath.lastIndexOf('/'))

  const defined = sameDirectoryFirst(
    await searchDefinitions(host, workspace.rootPath, name, '*.py'),
    currentDir
  )
  const definedTarget = firstMatchTarget(defined, name)
  if (definedTarget) {
    return definedTarget
  }

  const assigned = sameDirectoryFirst(
    await searchAssignments(host, workspace.rootPath, name, '*.py'),
    currentDir
  )
  const assignedTarget = firstMatchTarget(assigned, name)
  if (assignedTarget) {
    return assignedTarget
  }

  const moduleName = findImportedPythonModule(text, name)
  if (!moduleName) {
    return null
  }
  for (const candidate of moduleCandidates(moduleName, workspace.rootPath, currentDir)) {
    if (!(await host.pathExists(candidate))) {
      continue
    }
    const inModule = await searchDefinitions(
      host,
      candidate.slice(0, candidate.lastIndexOf('/')),
      name,
      candidate.slice(candidate.lastIndexOf('/') + 1)
    )
    const moduleTarget = firstMatchTarget(inModule, name)
    if (moduleTarget) {
      return moduleTarget
    }
    const content = await host.readFile(candidate)
    const moduleDefinition = findPythonDefinitionInText(content, name)
    if (moduleDefinition) {
      return {
        filePath: candidate,
        line: moduleDefinition.line,
        column: moduleDefinition.column,
        sameFile: false
      }
    }
  }
  return null
}

export function registerPythonDefinitionProvider(
  monaco: Pick<typeof Monaco, 'languages'>,
  host: PythonDefinitionHost
): void {
  // Monaco calls the provider while typing too (the suggest widget asks for definition links),
  // so growing words are skipped instead of triggering a worktree-wide search per keystroke.
  let lastWord: string | null = null
  let lastAt = 0

  monaco.languages.registerDefinitionProvider(PYTHON_LANGUAGE_ID, {
    provideDefinition: async (model, position) => {
      const until = model.getWordUntilPosition(position)
      if (!until || !/^[A-Za-z_]\w*$/.test(until.word)) {
        return null
      }
      const at = model.getWordAtPosition(position)
      const name = at && at.word.length > until.word.length ? at.word : until.word

      const now = Date.now()
      if (lastWord && name.startsWith(lastWord) && now - lastAt < 1500) {
        lastWord = name
        lastAt = now
        return null
      }
      lastWord = name
      lastAt = now

      const filePath = model.uri.fsPath ?? model.uri.path
      if (!filePath.endsWith('.py')) {
        return null
      }
      const workspace = host.resolveWorkspace(filePath)
      let target: PythonDefinitionTarget | null = null
      try {
        target = await resolvePythonDefinition({
          text: model.getValue(),
          name,
          filePath,
          host
        })
      } catch {
        return null
      }
      if (!target) {
        return null
      }
      if (target.sameFile) {
        return {
          uri: model.uri,
          range: {
            startLineNumber: target.line,
            startColumn: target.column,
            endLineNumber: target.line,
            endColumn: target.column + name.length
          }
        }
      }
      if (workspace) {
        host.openAndReveal(target, workspace)
      }
      return null
    }
  })
}
