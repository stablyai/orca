type JiraAdfTextNode = {
  type: 'text'
  text: string
}

type JiraAdfParagraphNode = {
  type: 'paragraph'
  content: JiraAdfTextNode[]
}

type JiraAdfDocument = {
  type: 'doc'
  version: 1
  content: JiraAdfParagraphNode[]
}

const LINE_FEED_CODE_UNIT = 10
const CARRIAGE_RETURN_CODE_UNIT = 13

export function buildJiraCreateTextAdf(text: string): JiraAdfDocument {
  const content: JiraAdfParagraphNode[] = []
  let lineStart = 0

  for (let index = 0; index <= text.length; index += 1) {
    if (index < text.length && text.charCodeAt(index) !== LINE_FEED_CODE_UNIT) {
      continue
    }
    const lineEnd =
      index > lineStart && text.charCodeAt(index - 1) === CARRIAGE_RETURN_CODE_UNIT
        ? index - 1
        : index
    const line = text.slice(lineStart, lineEnd)
    // Why: Jira ADF represents each visible text line as its own paragraph;
    // scan line boundaries directly so large pasted textarea values avoid a
    // duplicate full line array before the RPC payload is built.
    content.push({
      type: 'paragraph',
      content: line ? [{ type: 'text', text: line }] : []
    })
    lineStart = index + 1
  }

  return {
    type: 'doc',
    version: 1,
    content
  }
}
