import type {
  AzureDevOpsBoardStyleClause,
  AzureDevOpsBoardStyleRule,
  AzureDevOpsWorkItem
} from '../../../shared/azure-devops/boards-types'

export type CardStyle = { backgroundColor: string | null; titleColor: string | null }

// null when the value has no text form, so the clause cannot be compared.
function fieldTexts(value: unknown): string[] | null {
  if (typeof value === 'string') {
    return [value]
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return [String(value)]
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const texts: string[] = []
    if ('displayName' in value && typeof value.displayName === 'string') {
      texts.push(value.displayName)
    }
    if ('uniqueName' in value && typeof value.uniqueName === 'string') {
      texts.push(value.uniqueName)
    }
    return texts.length > 0 ? texts : null
  }
  return null
}

function asFiniteNumber(text: string): number | null {
  if (text.trim() === '') {
    return null
  }
  const n = Number(text)
  return Number.isFinite(n) ? n : null
}

// Negative when a < b; numeric only when both sides are numbers.
function compare(a: string, b: string): number {
  const na = asFiniteNumber(a)
  const nb = asFiniteNumber(b)
  if (na !== null && nb !== null) {
    return na - nb
  }
  const la = a.toLowerCase()
  const lb = b.toLowerCase()
  return la < lb ? -1 : la > lb ? 1 : 0
}

function contains(fieldName: string, actual: string, wanted: string): boolean {
  const needle = wanted.trim().toLowerCase()
  if (fieldName === 'System.Tags') {
    return actual.split(';').some((tag) => tag.trim().toLowerCase() === needle)
  }
  return actual.toLowerCase().includes(needle)
}

function isInList(actual: string, list: string): boolean {
  return list.split(',').some((entry) => compare(actual, entry.trim()) === 0)
}

function isMacroValue(value: string): boolean {
  return value.split(',').some((entry) => entry.trim().startsWith('@'))
}

function matchesPositive(
  operator: string,
  fieldName: string,
  actual: string,
  value: string
): boolean | null {
  switch (operator) {
    case '=':
      return compare(actual, value) === 0
    case '>':
      return compare(actual, value) > 0
    case '<':
      return compare(actual, value) < 0
    case '>=':
      return compare(actual, value) >= 0
    case '<=':
      return compare(actual, value) <= 0
    case 'contains':
      return contains(fieldName, actual, value)
    case 'in':
      return isInList(actual, value)
    default:
      return null
  }
}

const NEGATED_OPERATORS: Record<string, string> = {
  '<>': '=',
  'does not contain': 'contains',
  'not in': 'in'
}

/** null means this build cannot evaluate the clause. */
function evaluateClause(
  clause: AzureDevOpsBoardStyleClause,
  fields: Record<string, unknown>
): boolean | null {
  if (!Object.hasOwn(fields, clause.fieldName) || isMacroValue(clause.value)) {
    return null
  }
  const texts = fieldTexts(fields[clause.fieldName])
  if (texts === null) {
    return null
  }
  const negated = Object.hasOwn(NEGATED_OPERATORS, clause.operator)
  const base = negated ? NEGATED_OPERATORS[clause.operator] : clause.operator
  let anyMatch = false
  for (const text of texts) {
    const hit = matchesPositive(base, clause.fieldName, text, clause.value)
    if (hit === null) {
      return null
    }
    anyMatch = anyMatch || hit
  }
  return negated ? !anyMatch : anyMatch
}

function ruleMatches(item: AzureDevOpsWorkItem, rule: AzureDevOpsBoardStyleRule): boolean {
  let result: boolean | null = null
  for (const clause of rule.clauses) {
    const outcome = evaluateClause(clause, item.fields)
    // Every clause is evaluated: one unevaluable clause voids the rule even if the result is already decided.
    if (outcome === null) {
      return false
    }
    if (result === null) {
      result = outcome
    } else {
      result = clause.logicalOperator === 'or' ? result || outcome : result && outcome
    }
  }
  return result === true
}

/** First matching rule wins, as Azure DevOps applies them in order. */
export function resolveAzureDevOpsCardStyle(
  item: AzureDevOpsWorkItem,
  rules: readonly AzureDevOpsBoardStyleRule[]
): CardStyle | null {
  for (const rule of rules) {
    if (ruleMatches(item, rule)) {
      return { backgroundColor: rule.backgroundColor, titleColor: rule.titleColor }
    }
  }
  return null
}
