import { expandXlsxCellRangeList, type XlsxCellReference } from './xlsx-cell-reference'
import { decodeXlsxXmlText, forEachXlsxXmlElement } from './xlsx-xml-elements'

/**
 * A conditional formatting rule, reduced to what a read-only viewer can decide
 * for itself: the cells it covers, the test, and which `<dxf>` it paints.
 */
export type XlsxConditionalRule = {
  cells: XlsxCellReference[]
  type: XlsxConditionalRuleType
  operator?: string
  /** The rule's `<formula>` values, in document order. */
  formulas: string[]
  differentialFormatId: number
  priority: number
  stopIfTrue: boolean
}

/**
 * The rule types the viewer decides without a formula engine.
 *
 * `expression` rules are deliberately absent: their condition is an arbitrary
 * formula over other cells, which needs an evaluator the viewer does not have.
 * Guessing at them would paint cells the file never highlighted, so they are
 * dropped and the cell keeps its own style. `colorScale`, `dataBar` and
 * `iconSet` are also out for now — they render a scale rather than a `<dxf>`.
 */
const SUPPORTED_RULE_TYPES = [
  'cellIs',
  'containsBlanks',
  'notContainsBlanks',
  'containsText',
  'notContainsText',
  'beginsWith',
  'endsWith'
] as const

export type XlsxConditionalRuleType = (typeof SUPPORTED_RULE_TYPES)[number]

const SUPPORTED_RULE_TYPE_SET = new Set<string>(SUPPORTED_RULE_TYPES)

// Why: a sheet can carry a rule over an enormous range, and every covered cell
// costs an entry. This bounds one sheet's rules to something a viewer can hold.
const MAX_RULE_CELLS = 200_000

/** Parses `<conditionalFormatting>` blocks, dropping rules the viewer cannot decide. */
export function parseXlsxConditionalFormatting(xml: string): XlsxConditionalRule[] {
  const rules: XlsxConditionalRule[] = []

  forEachXlsxXmlElement(xml, 'conditionalFormatting', (block) => {
    const cells = expandXlsxCellRangeList(block.attributes.sqref ?? '', MAX_RULE_CELLS)
    if (cells.length === 0) {
      return true
    }
    forEachXlsxXmlElement(block.inner, 'cfRule', (rule) => {
      const parsed = readRule(rule.attributes, rule.inner, cells)
      if (parsed !== null) {
        rules.push(parsed)
      }
      return true
    })
    return true
  })

  // Why: Excel applies the lowest priority number first, and `stopIfTrue` only
  // means anything in that order.
  return rules.sort((left, right) => left.priority - right.priority)
}

function readRule(
  attributes: Record<string, string | undefined>,
  inner: string,
  cells: XlsxCellReference[]
): XlsxConditionalRule | null {
  const type = attributes.type
  if (type === undefined || !SUPPORTED_RULE_TYPE_SET.has(type)) {
    return null
  }
  const differentialFormatId = Number.parseInt(attributes.dxfId ?? '', 10)
  if (!Number.isInteger(differentialFormatId) || differentialFormatId < 0) {
    return null
  }
  const priority = Number.parseInt(attributes.priority ?? '', 10)
  const rule: XlsxConditionalRule = {
    cells,
    type: type as XlsxConditionalRuleType,
    formulas: readFormulas(inner),
    differentialFormatId,
    priority: Number.isInteger(priority) ? priority : Number.MAX_SAFE_INTEGER,
    stopIfTrue: attributes.stopIfTrue === '1' || attributes.stopIfTrue === 'true'
  }
  if (attributes.operator !== undefined) {
    rule.operator = attributes.operator
  }
  if (TEXT_RULE_TYPES.has(rule.type)) {
    // Why: a text rule is only decidable against a literal needle. Excel writes
    // it in the `text` attribute and repeats it inside a `SEARCH(...)` formula the
    // viewer cannot evaluate, so fall back to the literal in the formula and drop
    // the rule when neither yields one — `notContainsText` with no needle would
    // otherwise invert to true and repaint the whole range.
    const needle = readTextNeedle(attributes.text, rule.formulas[0])
    if (needle === undefined) {
      return null
    }
    rule.formulas = [needle]
  }
  return rule
}

const TEXT_RULE_TYPES = new Set<XlsxConditionalRuleType>([
  'containsText',
  'notContainsText',
  'beginsWith',
  'endsWith'
])

function readTextNeedle(
  textAttribute: string | undefined,
  formula: string | undefined
): string | undefined {
  if (textAttribute !== undefined && textAttribute !== '') {
    return decodeXlsxXmlText(textAttribute)
  }
  const quoted = /"((?:[^"]|"")+)"/.exec(formula ?? '')
  return quoted === null ? undefined : quoted[1]!.replaceAll('""', '"')
}

function readFormulas(inner: string): string[] {
  const formulas: string[] = []
  forEachXlsxXmlElement(inner, 'formula', (formula) => {
    formulas.push(decodeXlsxXmlText(formula.inner).trim())
    return true
  })
  return formulas
}

/** The value a rule is tested against: the cell's number when it has one. */
export type XlsxConditionalCellValue = {
  text: string
  numeric?: number
}

/** Decides whether a rule's condition holds for one cell. */
export function evaluateXlsxConditionalRule(
  rule: XlsxConditionalRule,
  value: XlsxConditionalCellValue
): boolean {
  switch (rule.type) {
    case 'containsBlanks':
      return value.text.trim() === ''
    case 'notContainsBlanks':
      return value.text.trim() !== ''
    case 'containsText':
      return matchesText(value.text, rule.formulas[0], (text, needle) => text.includes(needle))
    case 'notContainsText':
      return !matchesText(value.text, rule.formulas[0], (text, needle) => text.includes(needle))
    case 'beginsWith':
      return matchesText(value.text, rule.formulas[0], (text, needle) => text.startsWith(needle))
    case 'endsWith':
      return matchesText(value.text, rule.formulas[0], (text, needle) => text.endsWith(needle))
    case 'cellIs':
      return evaluateCellIs(rule, value)
  }
}

// Why: a text rule stores its needle quoted (`"Total"`) when it comes from a
// `<formula>` and bare when it comes from the `text` attribute.
function matchesText(
  text: string,
  needle: string | undefined,
  test: (text: string, needle: string) => boolean
): boolean {
  if (needle === undefined) {
    return false
  }
  const unquoted = unquoteFormulaText(needle)
  if (unquoted === '') {
    return false
  }
  return test(text.toLowerCase(), unquoted.toLowerCase())
}

function unquoteFormulaText(formula: string): string {
  const match = /^"(.*)"$/s.exec(formula)
  return match === null ? formula : match[1]!.replaceAll('""', '"')
}

function evaluateCellIs(rule: XlsxConditionalRule, value: XlsxConditionalCellValue): boolean {
  const first = readComparand(rule.formulas[0])
  if (first === undefined) {
    return false
  }
  // Why: a numeric comparison against a cell holding text is not a match, which
  // is also how it keeps a `< 0` rule off an empty cell.
  const numeric = value.numeric
  if (numeric === undefined) {
    return false
  }

  switch (rule.operator) {
    case 'equal':
      return numeric === first
    case 'notEqual':
      return numeric !== first
    case 'lessThan':
      return numeric < first
    case 'lessThanOrEqual':
      return numeric <= first
    case 'greaterThan':
      return numeric > first
    case 'greaterThanOrEqual':
      return numeric >= first
    case 'between':
    case 'notBetween': {
      const second = readComparand(rule.formulas[1])
      if (second === undefined) {
        return false
      }
      const low = Math.min(first, second)
      const high = Math.max(first, second)
      const within = numeric >= low && numeric <= high
      return rule.operator === 'between' ? within : !within
    }
    default:
      return false
  }
}

// Why: only a literal number is decidable here. A formula comparand refers to
// other cells, which needs the evaluator the viewer does not have.
function readComparand(formula: string | undefined): number | undefined {
  // Why: guard the empty string explicitly — `Number('')` is 0, which would turn
  // a rule with no threshold into a comparison against zero.
  if (formula === undefined || formula.trim() === '') {
    return undefined
  }
  const numeric = Number(formula)
  return Number.isFinite(numeric) ? numeric : undefined
}
