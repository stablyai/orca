import { z } from 'zod'
import { isUtf8ByteLengthWithinLimit } from '../../utf8-byte-limits'
import { pluginGrammarScopeSchema } from '../contributions/plugin-content-pack-contributions'

export const PLUGIN_SYNTAX_GRAMMAR_MAX_BYTES = 1024 * 1024
export const PLUGIN_SYNTAX_CONFIGURATION_MAX_BYTES = 64 * 1024
const JSON_DEPTH_LIMIT = 64
const JSON_NODE_LIMIT = 100_000

type GrammarRule = {
  name?: string
  contentName?: string
  comment?: string
  include?: string
  match?: string
  begin?: string
  end?: string
  while?: string
  applyEndPatternLast?: boolean | number
  patterns?: GrammarRule[]
  repository?: Record<string, GrammarRule>
  captures?: Record<string, GrammarRule>
  beginCaptures?: Record<string, GrammarRule>
  endCaptures?: Record<string, GrammarRule>
  whileCaptures?: Record<string, GrammarRule>
}

const repositoryKey = z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/)
const captureKey = z.string().regex(/^(?:0|[1-9][0-9]{0,2})$/)
const text = z.string().max(64 * 1024)
// Why an allowlist of keys: a grammar is data the TextMate engine interprets, so anything it does
// not understand is dropped rather than carried into the renderer.
const ruleSchema: z.ZodType<GrammarRule> = z.lazy(() =>
  z.object({
    name: z.string().max(1024).optional(),
    contentName: z.string().max(1024).optional(),
    comment: text.optional(),
    include: z
      .string()
      .max(256)
      .regex(
        /^(?:\$self|\$base|#[A-Za-z0-9_.-]+|[A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)+(?:#[A-Za-z0-9_.-]+)?)$/
      )
      .optional(),
    match: text.optional(),
    begin: text.optional(),
    end: text.optional(),
    while: text.optional(),
    applyEndPatternLast: z.union([z.boolean(), z.literal(0), z.literal(1)]).optional(),
    patterns: z.array(ruleSchema).max(10_000).optional(),
    repository: z.record(repositoryKey, ruleSchema).optional(),
    captures: z.record(captureKey, ruleSchema).optional(),
    beginCaptures: z.record(captureKey, ruleSchema).optional(),
    endCaptures: z.record(captureKey, ruleSchema).optional(),
    whileCaptures: z.record(captureKey, ruleSchema).optional()
  })
)

const grammarSchema = z.object({
  scopeName: pluginGrammarScopeSchema,
  patterns: z.array(ruleSchema).max(10_000),
  repository: z.record(repositoryKey, ruleSchema).default({})
})

const literal = z.string().min(1).max(128)
const pair = z.tuple([literal, literal])
const closingPair = z.object({ open: literal, close: literal })
const configurationSchema = z.object({
  comments: z.object({ lineComment: literal.optional(), blockComment: pair.optional() }).optional(),
  brackets: z.array(pair).max(64).optional(),
  autoClosingPairs: z.array(closingPair).max(64).optional(),
  surroundingPairs: z.array(closingPair).max(64).optional()
})

export type PluginGrammarArtifact = z.infer<typeof grammarSchema>
export type PluginLanguageConfiguration = z.infer<typeof configurationSchema>

function boundedJson(raw: string, limit: number): unknown {
  if (!isUtf8ByteLengthWithinLimit(raw, limit)) {
    throw new Error(`exceeds ${limit} bytes`)
  }
  const parsed: unknown = JSON.parse(raw)
  const pending = [{ value: parsed, depth: 0 }]
  let nodes = 0
  for (let entry = pending.pop(); entry; entry = pending.pop()) {
    if (++nodes > JSON_NODE_LIMIT || entry.depth > JSON_DEPTH_LIMIT) {
      throw new Error('is nested too deeply or too large')
    }
    if (entry.value && typeof entry.value === 'object') {
      for (const child of Object.values(entry.value)) {
        pending.push({ value: child, depth: entry.depth + 1 })
      }
    }
  }
  return parsed
}

export function parsePluginGrammarArtifact(raw: string, scopeName: string): PluginGrammarArtifact {
  const grammar = grammarSchema.parse(boundedJson(raw, PLUGIN_SYNTAX_GRAMMAR_MAX_BYTES))
  if (grammar.scopeName !== scopeName) {
    throw new Error(`grammar scope ${grammar.scopeName} does not match ${scopeName}`)
  }
  return grammar
}

export function parsePluginLanguageConfiguration(raw: string): PluginLanguageConfiguration {
  return configurationSchema.parse(boundedJson(raw, PLUGIN_SYNTAX_CONFIGURATION_MAX_BYTES))
}

function childRules(rule: GrammarRule): GrammarRule[] {
  return [
    ...(rule.patterns ?? []),
    ...Object.values(rule.repository ?? {}),
    ...Object.values(rule.captures ?? {}),
    ...Object.values(rule.beginCaptures ?? {}),
    ...Object.values(rule.endCaptures ?? {}),
    ...Object.values(rule.whileCaptures ?? {})
  ]
}

type RepositoryScope = { repository: Record<string, GrammarRule>; parent: RepositoryScope | null }

function hasRepositoryKey(scope: RepositoryScope | null, key: string): boolean {
  for (let current = scope; current; current = current.parent) {
    if (Object.hasOwn(current.repository, key)) {
      return true
    }
  }
  return false
}

/**
 * Every include that points inside the plugin must resolve: a `#key` in an enclosing repository,
 * or a sibling grammar's scope and key. An include of a scope outside the plugin (an embedded
 * `source.js`, say) is allowed; the engine finds no grammar for it and that region stays plain.
 * Linear in the number of rules: nested repositories chain to their parent instead of copying it.
 */
export function validatePluginGrammarIncludes(grammars: readonly PluginGrammarArtifact[]): void {
  const byScope = new Map(grammars.map((grammar) => [grammar.scopeName, grammar]))
  for (const grammar of grammars) {
    const root: RepositoryScope = { repository: grammar.repository, parent: null }
    const pending: { rule: GrammarRule; scope: RepositoryScope }[] = [
      { rule: { patterns: grammar.patterns }, scope: root }
    ]
    for (const value of Object.values(grammar.repository)) {
      pending.push({ rule: value, scope: root })
    }
    for (let entry = pending.pop(); entry; entry = pending.pop()) {
      const { rule } = entry
      const scope = rule.repository
        ? { repository: rule.repository, parent: entry.scope }
        : entry.scope
      if (rule.include && rule.include !== '$self' && rule.include !== '$base') {
        const [includeScope, key] = rule.include.split('#')
        const target = includeScope ? byScope.get(includeScope) : grammar
        const resolved = !target
          ? Boolean(includeScope)
          : !key ||
            (includeScope ? Object.hasOwn(target.repository, key) : hasRepositoryKey(scope, key))
        if (!resolved) {
          throw new Error(`grammar include ${rule.include} does not resolve inside the plugin`)
        }
      }
      for (const child of childRules({ ...rule, repository: undefined })) {
        pending.push({ rule: child, scope })
      }
      for (const child of Object.values(rule.repository ?? {})) {
        pending.push({ rule: child, scope })
      }
    }
  }
}

const metadataSchema = z.object({
  id: z.templateLiteral(['plugin:', z.string()]),
  pluginKey: z.string(),
  label: z.string(),
  extensions: z.array(z.string()),
  filenames: z.array(z.string()),
  revision: z.string()
})

const payloadSchema = z.object({
  id: z.templateLiteral(['plugin:', z.string()]),
  revision: z.string(),
  scopeName: pluginGrammarScopeSchema,
  grammars: z.array(grammarSchema).min(1).max(16),
  configuration: configurationSchema
})

/** What the editor needs to route files; grammars load only when a matching file opens. */
export type PluginSyntaxMetadata = z.infer<typeof metadataSchema>
export type PluginSyntaxPayload = z.infer<typeof payloadSchema>

export function isPluginSyntaxMetadata(value: unknown): value is PluginSyntaxMetadata {
  return metadataSchema.safeParse(value).success
}

export function parsePluginSyntaxPayload(value: unknown): PluginSyntaxPayload | null {
  const parsed = payloadSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}
