import type { TestElement } from './testing-tree'

// Past this, a summary stops being a glance; `tree()` has the rest.
const MAX_LINES = 12
const MAX_TEXT = 60

const quote = (text: string | undefined): string => {
  const flat = (text ?? '').replace(/\s+/g, ' ').trim()
  return JSON.stringify(flat.length > MAX_TEXT ? `${flat.slice(0, MAX_TEXT - 1)}…` : flat)
}

const countOf = (value: unknown): number => (Array.isArray(value) ? value.length : 0)

/** One line for an element worth a glance, or null for structure and plain controls. */
function summaryLine(element: TestElement, tabs: ReadonlyMap<string, string>): string | null {
  const { props } = element
  switch (element.type) {
    case 'Heading':
      return `Heading ${quote(element.text)}`
    case 'Callout':
      return `Callout ${String(props.tone ?? 'neutral')} ${quote(element.label ?? element.text)}`
    case 'EmptyState':
      return `EmptyState ${quote(element.label)}`
    case 'Table':
      return `Table ${quote(element.label)}: ${countOf(props.rows)} row(s)${props.hasMore === true ? ', more' : ''}`
    case 'Tree':
      return `Tree ${quote(element.label)}: ${countOf(props.items)} top-level item(s)`
    case 'Tabs':
      return `Tabs ${quote(element.label)}: ${quote(tabs.get(element.path))} selected`
    case 'Skeleton':
    case 'Spinner':
      return `${element.type} ${quote(element.label ?? 'Loading')}`
    case 'Text':
      return props.tone === 'danger' || props.tone === 'warning'
        ? `Text ${String(props.tone)} ${quote(element.text)}`
        : null
    default:
      return null
  }
}

/**
 * What a person would notice first in a drawn panel, one short line each: headings, callouts,
 * empty states, tables and trees with their size, the selected tab, loading placeholders and
 * danger or warning text. For `orca plugin check` and quick test assertions.
 */
export function summarizeElements(
  elements: readonly TestElement[],
  /** The selected tab's label per Tabs path, as Orca shows it. */
  tabs: ReadonlyMap<string, string>
): string[] {
  const lines: string[] = []
  for (const element of elements) {
    if (element.type === 'List') {
      const items = elements.filter(
        (item) => item.type === 'ListItem' && item.path.startsWith(`${element.path}/`)
      ).length
      lines.push(`List ${quote(element.label)}: ${items} item(s)`)
      continue
    }
    const line = summaryLine(element, tabs)
    if (line) {
      lines.push(line)
    }
  }
  return lines.length > MAX_LINES
    ? [...lines.slice(0, MAX_LINES), `… ${lines.length - MAX_LINES} more`]
    : lines
}
