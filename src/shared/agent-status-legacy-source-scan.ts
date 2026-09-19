import {
  blankStringContents,
  blankStringContentsDesynced,
  stripComments
} from './source-scan/source-tree-scan'

export type AgentStatusLegacyMutationBypass = {
  kind: 'direct-mutation' | 'alias-mutation' | 'map-cast' | 'passed-map' | 'scan-desync'
  detail: string
}

const MUTATOR_NAMES = '(?:set|delete|clear)'
const IDENTIFIER = '[A-Za-z_$][A-Za-z0-9_$]*'

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function aliasesForLegacyStatusMap(source: string): Set<string> {
  const aliases = new Set<string>()
  const assignment = new RegExp(
    `\\b(?:const|let|var)\\s+(${IDENTIFIER})\\s*=\\s*(?:this\\.)?state\\.lastStatusByPaneKey\\s*(?:;|\\n|$)`,
    'g'
  )
  for (const match of source.matchAll(assignment)) {
    aliases.add(match[1]!)
  }
  const destructuring = new RegExp(
    `\\b(?:const|let|var)\\s*\\{[^}]*\\blastStatusByPaneKey(?:\\s*:\\s*(${IDENTIFIER}))?`,
    'g'
  )
  for (const match of source.matchAll(destructuring)) {
    aliases.add(match[1] ?? 'lastStatusByPaneKey')
  }
  return aliases
}

function isReadonlySnapshotCallPrefix(prefix: string): boolean {
  return /(?:Array\.from|new\s+Map)\(\s*$/.test(prefix)
}

export function findAgentStatusLegacyMutationBypasses(
  source: string
): AgentStatusLegacyMutationBypass[] {
  const stripped = stripComments(source)
  if (blankStringContentsDesynced(stripped)) {
    return [{ kind: 'scan-desync', detail: 'source scanner lost quote or template state' }]
  }
  const code = blankStringContents(stripped)
  const bypasses: AgentStatusLegacyMutationBypass[] = []
  if (
    new RegExp(`\\blastStatusByPaneKey\\s*\\.\\s*${MUTATOR_NAMES}\\s*\\(`).test(code) ||
    /\[['"]lastStatusByPaneKey['"]\]\s*\.\s*(?:set|delete|clear)\s*\(/.test(stripped)
  ) {
    bypasses.push({ kind: 'direct-mutation', detail: 'lastStatusByPaneKey mutator call' })
  }
  if (
    new RegExp(
      `\\blastStatusByPaneKey\\b[\\s\\S]{0,100}\\bas\\s+(?:unknown\\s+as\\s+)?(?:Readonly)?Map\\b[\\s\\S]{0,100}\\.\\s*${MUTATOR_NAMES}\\s*\\(`
    ).test(code)
  ) {
    bypasses.push({ kind: 'map-cast', detail: 'lastStatusByPaneKey cast back to a mutable Map' })
  }

  const aliases = aliasesForLegacyStatusMap(code)
  for (const alias of aliases) {
    const escaped = escapeRegExp(alias)
    if (new RegExp(`\\b${escaped}\\s*\\.\\s*${MUTATOR_NAMES}\\s*\\(`).test(code)) {
      bypasses.push({ kind: 'alias-mutation', detail: `${alias} mutates an aliased status map` })
    }
    const passed = new RegExp(`\\b${IDENTIFIER}(?:\\.${IDENTIFIER})*\\s*\\(\\s*${escaped}\\b`, 'g')
    for (const match of code.matchAll(passed)) {
      const prefix = code.slice(
        Math.max(0, match.index - 24),
        match.index + match[0].indexOf('(') + 1
      )
      if (!isReadonlySnapshotCallPrefix(prefix)) {
        bypasses.push({ kind: 'passed-map', detail: `${alias} is passed to another function` })
        break
      }
    }
  }

  const directPass = new RegExp(
    `\\b(${IDENTIFIER}(?:\\.${IDENTIFIER})*)\\s*\\(\\s*((?:this\\.)?state\\.lastStatusByPaneKey)\\s*[,)]`,
    'g'
  )
  for (const match of code.matchAll(directPass)) {
    if (match[1] !== 'Array.from' && match[1] !== 'Map') {
      bypasses.push({
        kind: 'passed-map',
        detail: 'lastStatusByPaneKey is passed to another function'
      })
    }
  }
  return bypasses
}
