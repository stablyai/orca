import type { ThemeStudioVariant } from '../../../../shared/theme-studio/theme-studio-draft'
import { pluginMonacoTokenRules } from '@/lib/editor/appearance/plugin-monaco-token-rules'

type Scope = 'comment' | 'keyword' | 'string' | 'function' | 'type' | 'plain'

// Why fallbacks by scope: a theme without syntax rules shows the editor's own defaults.
const FALLBACK: Record<Exclude<Scope, 'plain'>, string> = {
  comment: 'var(--muted-foreground)',
  keyword: 'var(--chart-2, var(--primary))',
  string: 'var(--git-decoration-added)',
  function: 'var(--git-decoration-modified)',
  type: 'var(--text-link)'
}
type Line = { parts: [Scope, string][]; diff?: 'added' | 'removed' }

const LINES: Line[] = [
  { parts: [['comment', '// Greets each visitor and says when they came back.']] },
  {
    parts: [
      ['keyword', 'import'],
      ['plain', ' { formatDistance } '],
      ['keyword', 'from'],
      ['string', " './time'"]
    ]
  },
  { parts: [] },
  {
    parts: [
      ['keyword', 'export interface '],
      ['type', 'Visitor'],
      ['plain', ' {']
    ]
  },
  {
    parts: [
      ['plain', '  name: '],
      ['type', 'string']
    ]
  },
  { parts: [['plain', '}']] },
  { parts: [] },
  {
    parts: [
      ['keyword', 'export function '],
      ['function', 'greet'],
      ['plain', '(visitor: '],
      ['type', 'Visitor'],
      ['plain', ') {']
    ]
  },
  {
    parts: [
      ['keyword', '  return '],
      ['string', "'Hello'"]
    ],
    diff: 'removed'
  },
  {
    parts: [
      ['keyword', '  const '],
      ['plain', 'ago = '],
      ['function', 'formatDistance'],
      ['plain', '(visitor.lastSeen)']
    ],
    diff: 'added'
  },
  {
    parts: [
      ['keyword', '  return '],
      ['string', '`Welcome back, ${visitor.name}`']
    ],
    diff: 'added'
  },
  { parts: [['plain', '}']] }
]

// Why numbered here: the lines are fixed, and their number is both the gutter and the key.
const NUMBERED = LINES.map((line, index) => ({ ...line, number: index + 1 }))

// Why the editor's own resolver: TextMate precedence (most specific scope, later rules win)
// decides which rule colors `import`, exactly as Monaco sees it.
function scopeColors(variant: ThemeStudioVariant | null): (scope: Scope) => string {
  const rules = variant?.tokenColors?.length
    ? pluginMonacoTokenRules(variant.tokenColors, (value) => value)
    : []
  return (scope) => {
    if (scope === 'plain') {
      return 'var(--foreground)'
    }
    return rules.find((rule) => rule.token === scope)?.foreground ?? FALLBACK[scope]
  }
}

/** The code editor surface: syntax colors from the theme's rules and diff backgrounds. */
export function SpecimenEditor({
  variant
}: {
  variant: ThemeStudioVariant | null
}): React.JSX.Element {
  const colorOf = scopeColors(variant)
  return (
    <div
      className="min-h-0 flex-1 overflow-hidden py-3 font-mono text-[12.5px] leading-[1.65]"
      style={{ background: 'var(--editor-surface)' }}
    >
      {NUMBERED.map((line) => (
        <div
          key={line.number}
          className="flex whitespace-pre"
          style={line.diff ? { background: `var(--diff-${line.diff}-background)` } : undefined}
        >
          <span className="w-10 shrink-0 pr-3 text-right text-muted-foreground opacity-70">
            {line.number}
          </span>
          <span
            className="w-4 shrink-0"
            style={{ color: line.diff ? `var(--diff-${line.diff})` : undefined }}
          >
            {line.diff === 'added' ? '+' : line.diff === 'removed' ? '-' : ''}
          </span>
          {line.parts.map(([scope, text], part) => (
            <span key={part} style={{ color: colorOf(scope) }}>
              {text}
            </span>
          ))}
        </div>
      ))}
    </div>
  )
}
