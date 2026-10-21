import type { Element, RootContent } from 'hast'
import {
  countMarkdownPreviewNodes,
  getMarkdownPreviewTreeText,
  isMarkdownPreviewBlockTooLarge
} from './markdown-preview-tree-content'

function elements(node: Element): Element[] | null {
  const children: Element[] = []
  for (const child of node.children) {
    if (child.type === 'element') {
      children.push(child)
    } else if (child.type !== 'text' || child.value.trim()) {
      return null
    }
  }
  return children
}

export function splitMarkdownPreviewTable(node: RootContent): RootContent[] {
  if (
    node.type !== 'element' ||
    node.tagName !== 'table' ||
    !isMarkdownPreviewBlockTooLarge(node)
  ) {
    return [node]
  }
  const sections = elements(node)
  if (!sections || sections.length !== 2) {
    return [node]
  }
  const [head, body] = sections
  if (head.tagName !== 'thead' || body.tagName !== 'tbody') {
    return [node]
  }
  if ([node, body].some((section) => Object.keys(section.properties).some((key) => key !== 'id'))) {
    return [node]
  }
  const headers = elements(head)
  const rows = elements(body)
  if (!headers || headers.length !== 1 || !rows?.length) {
    return [node]
  }
  const headerCells = elements(headers[0])
  if (!headerCells?.length) {
    return [node]
  }
  for (const row of [...headers, ...rows]) {
    const cells = elements(row)
    if (
      row.tagName !== 'tr' ||
      !row.position ||
      !cells ||
      cells.length !== headerCells.length ||
      cells.some(
        (cell) =>
          !['th', 'td'].includes(cell.tagName) || cell.properties.rowSpan || cell.properties.colSpan
      )
    ) {
      return [node]
    }
  }
  const groups: Element[][] = []
  let group: Element[] = []
  let nodes = countMarkdownPreviewNodes({ children: [head] }, 512)
  let characters = getMarkdownPreviewTreeText(head).length
  if (
    nodes + countMarkdownPreviewNodes({ children: [rows[0]] }, 512) > 512 ||
    characters + getMarkdownPreviewTreeText(rows[0]).length > 8192
  ) {
    groups.push([])
    nodes = 0
    characters = 0
  }
  for (const [rowIndex, row] of rows.entries()) {
    const rowNodes = countMarkdownPreviewNodes({ children: [row] }, 512)
    const rowCharacters = getMarkdownPreviewTreeText(row).length
    if (
      group.length &&
      (rowIndex % 8 === 0 || nodes + rowNodes > 512 || characters + rowCharacters > 8192)
    ) {
      groups.push(group)
      group = []
      nodes = 0
      characters = 0
    }
    group.push(row)
    nodes += rowNodes
    characters += rowCharacters
  }
  groups.push(group)
  const columnLabel = headerCells
    .map((cell) => getMarkdownPreviewTreeText(cell))
    .join(', ')
    .slice(0, 512)
  const firstBodyGroup = groups.findIndex((rows) => rows.length > 0)
  const headerEnd = head.position?.end
  const firstRowStart = rows[0].position?.start
  const headerGroupEnd =
    headerEnd && firstRowStart && firstRowStart.line > headerEnd.line
      ? { line: firstRowStart.line - 1, column: 1 }
      : headerEnd
  let rowOffset = 0
  return groups.map((groupRows, index) => {
    const properties = { ...node.properties }
    if (index > 0) {
      delete properties.id
    }
    properties.dataPreviewTableStart = index === 0
    properties.dataPreviewTableEnd = index === groups.length - 1
    properties.style = 'table-layout: fixed; width: 100%'
    properties.ariaLabel = columnLabel
    const colgroup: Element = {
      type: 'element',
      tagName: 'colgroup',
      properties: {},
      children: headerCells.map(() => ({
        type: 'element',
        tagName: 'col',
        properties: { style: `width: ${100 / headerCells.length}%` },
        children: []
      }))
    }
    const chunkRows = groupRows.map((row, rowIndex) => ({
      ...row,
      properties: { ...row.properties, dataPreviewTableRowEven: (rowOffset + rowIndex) % 2 === 1 }
    }))
    rowOffset += groupRows.length
    const start = index === 0 ? node.position?.start : groupRows[0].position?.start
    const end = groupRows.at(-1)?.position?.end ?? headerGroupEnd
    return {
      ...node,
      properties,
      position: start && end ? { start, end } : undefined,
      children: [
        colgroup,
        ...(index === 0 ? [head] : []),
        ...(chunkRows.length
          ? [
              {
                ...body,
                properties:
                  index === firstBodyGroup
                    ? body.properties
                    : { ...body.properties, id: undefined },
                position: undefined,
                children: chunkRows
              }
            ]
          : [])
      ]
    }
  })
}
