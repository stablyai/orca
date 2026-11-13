// Cloud glossary lint (design-squad spec, JA-25): user-visible strings on Orca Cloud surfaces must
// use the glossary's words (.context/cloud/specs/glossary.md). Scans translate()/t() fallbacks,
// i18n plural defaults, JSX text and user-facing JSX attributes; never identifiers or imports.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript-api'
import { globSync } from 'glob'
import { describe, expect, it } from 'vitest'
import allowlist from './cloud-glossary-allowlist.json'
import {
  isAllowed,
  staleAllowEntries,
  type AllowEntry,
  type GlossaryHit
} from './cloud-glossary-allowlist-match'

const ROOT = path.resolve(__dirname, '../../../../..')

const SCOPE = [
  'src/renderer/src/components/**/{orca-cloud,cloud,billing,hosted-sandbox}*/**/*.{ts,tsx}',
  'src/renderer/src/components/settings/**/{OrcaCloud,Cloud,PlanBilling,AgentAccounts,Accounts}*.tsx',
  'src/renderer/src/components/worktree-creation/Vm*.tsx',
  'src/renderer/src/components/worktree-creation/*Cloud*.tsx',
  // Copy tables behind the Vm* components (design-squad scope fix).
  'src/renderer/src/components/worktree-creation/vm-*.ts',
  'src/renderer/src/lib/*cloud*.ts',
  // Settings nav copy for the Orca Cloud group (missed by the component globs).
  'src/renderer/src/hooks/*orca-cloud*.ts',
  'mobile/src/**/*{Cloud,cloud}*.tsx'
]
const EXCLUDE = ['**/__tests__/**', '**/*.test.*', '**/*.fixture.tsx', '**/*.stories.tsx']

type Rule = { term: string; pattern: RegExp; use: string; row: string }

const RULES: Rule[] = [
  { term: 'VM', pattern: /\bVMs?\b|virtual machine/i, use: 'sandbox', row: 'The machine' },
  { term: 'worktree', pattern: /\bworktrees?\b/i, use: 'workspace', row: 'Unit of work' },
  { term: 'Claude Code', pattern: /\bClaude Code\b/i, use: 'Claude', row: 'Agent source' },
  {
    term: 'suspend',
    pattern: /\bsuspend(ed|s|ing)?\b/i,
    use: 'asleep / go to sleep',
    row: 'Lifecycle verbs'
  },
  {
    term: 'hibernate',
    pattern: /\bhibernat/i,
    use: 'asleep / go to sleep',
    row: 'Lifecycle verbs'
  },
  {
    term: 'per hour',
    pattern: /\/hr\b|\$\d+(\.\d+)?\/hour|(?<!sandbox )\bper hour\b/i,
    use: 'per sandbox hour',
    row: 'Overage'
  },
  {
    term: 'hours exhausted',
    pattern: /hours exhausted|No hours left/i,
    use: 'Out of sandbox hours',
    row: 'Out of hours'
  },
  {
    term: 'this Mac',
    pattern: /Sync to a local directory|\bthis Mac\b/i,
    use: 'Mirror to this computer / this computer',
    row: 'Mirror to this computer'
  },
  { term: 'credits', pattern: /\bcredits?\b/i, use: 'sandbox hours', row: 'Time unit' },
  {
    term: 'payment due',
    pattern: /payment due|\boverdue\b/i,
    use: 'Payment failed',
    row: 'Payment problem'
  },
  {
    term: 'spend cap',
    pattern: /Monthly cap \(\$\)|overage limit|\bbudget\b/i,
    use: 'Monthly spend cap',
    row: 'Overage'
  },
  { term: 'container', pattern: /\bcontainers?\b/i, use: 'sandbox', row: 'The machine' },
  { term: 'instance', pattern: /\binstances?\b/i, use: 'sandbox', row: 'The machine' }
]

const TEXT_ATTRIBUTES = new Set([
  'title',
  'aria-label',
  'aria-description',
  'placeholder',
  'label',
  'description',
  'alt'
])
const TRANSLATE_CALLEES = new Set(['t', 'translate'])

type Hit = GlossaryHit & { rule: Rule }

function stringValue(node: ts.Node): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text
  }
  if (ts.isTemplateExpression(node)) {
    return [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join(' ')
  }
  return null
}

const SKIP_ATTRIBUTES =
  /^(className|class|id|key|testId|data-.*|href|src|role|type|name|variant|size|side|align)$/
const SKIP_PROPERTIES =
  /^(className|id|key|testId|kind|type|variant|status|state|icon|href|path|url|pane|section|sectionId)$/

/** A string literal that could be user-visible copy: has a space, isn't a key, import or styling. */
function isCopyLiteral(node: ts.Node): boolean {
  if (
    !ts.isStringLiteral(node) &&
    !ts.isNoSubstitutionTemplateLiteral(node) &&
    !ts.isTemplateExpression(node)
  ) {
    return false
  }
  const text = stringValue(node) ?? ''
  if (!/\s/.test(text.trim()) || !/[A-Za-z]/.test(text)) {
    return false // pure identifiers, ids and paths
  }
  const parent = node.parent
  if (
    ts.isImportDeclaration(parent) ||
    ts.isExportDeclaration(parent) ||
    ts.isExternalModuleReference(parent) ||
    ts.isLiteralTypeNode(parent)
  ) {
    return false
  }
  if (ts.isPropertyAssignment(parent) && parent.name === node) {
    return false // object keys
  }
  if (
    ts.isPropertyAssignment(parent) &&
    SKIP_PROPERTIES.test(parent.name.getText().replace(/['"]/g, ''))
  ) {
    return false
  }
  const attr = ts.isJsxAttribute(parent)
    ? parent
    : ts.isJsxExpression(parent) && ts.isJsxAttribute(parent.parent)
      ? parent.parent
      : null
  if (attr && SKIP_ATTRIBUTES.test(attr.name.getText())) {
    return false
  }
  // cn()/clsx() class lists and translation keys (the first argument of t()).
  if (ts.isCallExpression(parent)) {
    const callee = parent.expression.getText()
    if (/^(cn|clsx|cva|twMerge)$/.test(callee)) {
      return false
    }
    if (TRANSLATE_CALLEES.has(callee.split('.').pop() ?? '') && parent.arguments[0] === node) {
      return false
    }
  }
  return true
}

/** User-visible strings in one file, with their 1-based lines. */
export function visibleStrings(file: string, source: string): { line: number; text: string }[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const out: { line: number; text: string }[] = []
  const push = (node: ts.Node, text: string | null): void => {
    if (text && /[A-Za-z]/.test(text)) {
      out.push({ line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, text })
    }
  }
  const visit = (node: ts.Node): void => {
    if (isCopyLiteral(node)) {
      // Copy tables, object-literal values and template parts: anywhere these terms can hide.
      push(node, stringValue(node))
    } else if (ts.isJsxText(node)) {
      push(node, node.text.trim())
    } else if (ts.isJsxAttribute(node) && node.initializer) {
      const name = node.name.getText(sf)
      if (TEXT_ATTRIBUTES.has(name)) {
        const init = node.initializer
        push(
          init,
          ts.isJsxExpression(init) && init.expression
            ? stringValue(init.expression)
            : stringValue(init)
        )
      }
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression
      const name = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : ''
      if (TRANSLATE_CALLEES.has(name) && node.arguments.length >= 2) {
        push(node.arguments[1], stringValue(node.arguments[1]))
        const options = node.arguments[2]
        if (options && ts.isObjectLiteralExpression(options)) {
          for (const prop of options.properties) {
            if (
              ts.isPropertyAssignment(prop) &&
              prop.name.getText(sf).replace(/['"]/g, '').startsWith('defaultValue')
            ) {
              push(prop.initializer, stringValue(prop.initializer))
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  const seen = new Set<string>()
  return out.filter((entry) => {
    const key = `${entry.line}:${entry.text}`
    if (seen.has(key)) {
      return false
    }
    seen.add(key)
    return true
  })
}

function scopeFiles(): string[] {
  return [...new Set(SCOPE.flatMap((g) => globSync(g, { cwd: ROOT, ignore: EXCLUDE })))].sort()
}

function findHits(): Hit[] {
  const hits: Hit[] = []
  for (const file of scopeFiles()) {
    const source = readFileSync(path.join(ROOT, file), 'utf8')
    for (const { line, text } of visibleStrings(file, source)) {
      for (const rule of RULES) {
        if (rule.pattern.test(text)) {
          hits.push({ file, line, term: rule.term, text, rule })
        }
      }
    }
  }
  return hits
}

const ALLOW: AllowEntry[] = allowlist

describe('cloud glossary lint', () => {
  const hits = findHits()

  it('scans a real scope', () => {
    expect(scopeFiles().length).toBeGreaterThan(20)
  })

  it('every allowlist entry has a reason and still matches a string', () => {
    const problems = staleAllowEntries(hits, ALLOW).map(
      (e) =>
        `stale or unexplained allowlist entry: ${e.path} "${e.term}" match ${JSON.stringify(e.match)}`
    )
    expect(problems).toEqual([])
  })

  it('cloud strings use glossary words', () => {
    const failures = hits
      .filter((h) => !ALLOW.some((e) => isAllowed(h, e)))
      .map(
        (h) =>
          `cloud glossary: "${h.term}" at ${h.file}:${h.line}; use "${h.rule.use}" (glossary row: ${h.rule.row}). ` +
          `Allowlist with a reason only if this string is not shown in Orca Cloud. Text: ${JSON.stringify(h.text.slice(0, 120))}`
      )
    expect(failures).toEqual([])
  })
})

describe('allowlist matching', () => {
  const file = 'src/renderer/src/components/worktree-creation/vm-build-sheet-copy.ts'
  const entry: AllowEntry = {
    path: file,
    term: 'VM',
    match: 'Your VM workspace is ready',
    reason: 'recipe-VM branch'
  }
  const hit = (over: Partial<GlossaryHit> = {}): GlossaryHit => ({
    file,
    line: 74,
    term: 'VM',
    text: 'Your VM workspace is ready',
    ...over
  })

  it('still allows the same string after it moves to another line', () => {
    expect(isAllowed(hit({ line: 74 }), entry)).toBe(true)
    expect(isAllowed(hit({ line: 112 }), entry)).toBe(true)
  })

  it('does not allow a different string with the same term in the same file', () => {
    expect(isAllowed(hit({ text: 'Delete this VM?' }), entry)).toBe(false)
  })

  it('does not allow the same snippet in a different file', () => {
    expect(isAllowed(hit({ file: 'src/renderer/src/lib/other-cloud.ts' }), entry)).toBe(false)
  })

  it('reports an entry with no matching hit as stale', () => {
    expect(staleAllowEntries([hit({ text: 'Delete this VM?' })], [entry])).toEqual([entry])
    expect(staleAllowEntries([hit()], [entry])).toEqual([])
  })

  it('reports an entry with an empty reason', () => {
    const unexplained = { ...entry, reason: '  ' }
    expect(staleAllowEntries([hit()], [unexplained])).toEqual([unexplained])
  })
})
