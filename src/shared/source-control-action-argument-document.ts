import { analyzeAgentChoiceArgs } from './agent-choice-args'
import { reconcileAgentChoiceArgsDetailed } from './agent-choice-reconciliation'
import type { AgentDedicatedChoices } from './agent-launch-choices'
import { PERMISSION_LAUNCH_GRAMMARS } from './agent-permission-args'
import { tokenizeStartupCommand } from './tui-agent-startup-shell'
import { isTuiAgent } from './tui-agent-config'
import type { TuiAgent } from './tui-agent'
import type { SourceControlActionRecipe } from './source-control-ai-actions'

export type ActionArgumentChoices = {
  syntaxAgent: TuiAgent
  nodes: { at: number; text: string }[]
}

type ArgumentDocument = Pick<SourceControlActionRecipe, 'agentArgs' | 'argumentChoices'>

export function lowerActionArgumentChoices(document: ArgumentDocument): string | undefined {
  const raw = document.agentArgs
  if (raw === undefined || !document.argumentChoices) {
    return raw
  }
  const chunks: string[] = []
  let cursor = 0
  for (const node of document.argumentChoices.nodes) {
    chunks.push(raw.slice(cursor, node.at), ' ', node.text, ' ')
    cursor = node.at
  }
  chunks.push(raw.slice(cursor))
  return chunks.join('').trim()
}

export function trimActionArgumentDocument<T extends ArgumentDocument>(document: T): T {
  if (typeof document.agentArgs !== 'string') {
    return document
  }
  const leading = document.agentArgs.length - document.agentArgs.trimStart().length
  const agentArgs = document.agentArgs.trim()
  return {
    ...document,
    agentArgs,
    ...(document.argumentChoices
      ? {
          argumentChoices: {
            ...document.argumentChoices,
            nodes: document.argumentChoices.nodes.map((node) => ({
              ...node,
              at: Math.max(0, Math.min(agentArgs.length, node.at - leading))
            }))
          }
        }
      : {})
  }
}

export function readActionArgumentNode(agent: TuiAgent, text: string) {
  const result = reconcileAgentChoiceArgsDetailed({
    agent,
    userArgs: text,
    choices: {},
    mode: 'load',
    keys: new Set(['model', 'effort'])
  })
  return result.userArgs === '' && result.selected.length === 1 ? result.selected[0] : undefined
}

export function normalizeActionArgumentDocument<T extends ArgumentDocument>(
  document: T,
  value: unknown,
  agent: unknown
): T {
  if (value === undefined) {
    return document
  }
  if (
    !value ||
    typeof value !== 'object' ||
    !('syntaxAgent' in value) ||
    !isTuiAgent(value.syntaxAgent) ||
    value.syntaxAgent !== agent ||
    typeof document.agentArgs !== 'string' ||
    !('nodes' in value) ||
    !Array.isArray(value.nodes)
  ) {
    throw new Error('Invalid action argument choices')
  }
  const nodes: ActionArgumentChoices['nodes'] = []
  const keys = new Set<string>()
  let at = 0
  for (const item of value.nodes) {
    if (
      !item ||
      typeof item !== 'object' ||
      !Number.isInteger(item.at) ||
      item.at < at ||
      item.at > document.agentArgs.length ||
      typeof item.text !== 'string'
    ) {
      throw new Error('Invalid action argument choice position')
    }
    const candidates = analyzeAgentChoiceArgs(value.syntaxAgent, item.text).occurrences
    if (
      candidates.length !== 1 ||
      !['model', 'effort'].includes(candidates[0].key) ||
      item.text.slice(0, candidates[0].start).trim() ||
      item.text.slice(candidates[0].end).trim()
    ) {
      throw new Error('Invalid action argument choice atom')
    }
    const key = candidates[0].key
    if (keys.has(key)) {
      throw new Error('Duplicate action argument choice')
    }
    keys.add(key)
    nodes.push({ at: item.at, text: item.text })
    at = item.at
  }
  if (!nodes.length) {
    return document
  }
  const argumentChoices = { syntaxAgent: value.syntaxAgent, nodes }
  return lowerActionArgumentNodes(
    { ...document, argumentChoices },
    (node) => !readActionArgumentNode(argumentChoices.syntaxAgent, node.text)
  )
}

export function lowerActionArgumentNodes<T extends ArgumentDocument>(
  document: T,
  lower: (node: ActionArgumentChoices['nodes'][number]) => boolean
): T {
  const argumentChoices = document.argumentChoices
  if (!argumentChoices || typeof document.agentArgs !== 'string') {
    return document
  }
  const chunks: string[] = []
  const retained: ActionArgumentChoices['nodes'] = []
  let cursor = 0
  let length = 0
  for (const node of argumentChoices.nodes) {
    const prefix = document.agentArgs.slice(cursor, node.at)
    chunks.push(prefix)
    length += prefix.length
    cursor = node.at
    if (!lower(node)) {
      retained.push({ ...node, at: length })
    } else {
      const text = ` ${node.text} `
      chunks.push(text)
      length += text.length
    }
  }
  chunks.push(document.agentArgs.slice(cursor))
  if (retained.length !== argumentChoices.nodes.length) {
    return {
      ...document,
      agentArgs: chunks.join(''),
      argumentChoices: retained.length ? { ...argumentChoices, nodes: retained } : undefined
    }
  }
  return document
}

export function actionArgumentChoicesValue(document: ArgumentDocument): AgentDedicatedChoices {
  const choices: AgentDedicatedChoices = {}
  for (const node of document.argumentChoices?.nodes ?? []) {
    const occurrence = readActionArgumentNode(document.argumentChoices!.syntaxAgent, node.text)
    if (occurrence?.key === 'model') {
      choices.model = occurrence.value
    } else if (occurrence) {
      choices.options = { ...choices.options, [occurrence.key]: occurrence.value }
    }
  }
  return choices
}

export function transportActionArgumentChoices(
  document: ArgumentDocument,
  next: string
): ActionArgumentChoices | undefined {
  const current = document.agentArgs ?? ''
  const choices = document.argumentChoices
  if (!choices || current === next) {
    return choices
  }
  let start = 0
  while (start < current.length && start < next.length && current[start] === next[start]) {
    start++
  }
  let end = current.length
  let nextEnd = next.length
  while (end > start && nextEnd > start && current[end - 1] === next[nextEnd - 1]) {
    end--
    nextEnd--
  }
  const parses = PERMISSION_LAUNCH_GRAMMARS.map((shell) => tokenizeStartupCommand(next, shell))
  const nodes = choices.nodes.map((node) => {
    let at = node.at <= start ? node.at : node.at >= end ? node.at + nextEnd - end : nextEnd
    if (parses.some((parsed) => !parsed.ok)) {
      return { ...node, at: 0 }
    }
    const cursors = parses.map(() => 0)
    const boundary = (position: number) =>
      parses.every((parsed, index) => {
        if (!parsed.ok) {
          return false
        }
        while (
          cursors[index] < parsed.spans.length &&
          parsed.spans[cursors[index]].end <= position
        ) {
          cursors[index]++
        }
        const span = parsed.spans[cursors[index]]
        return !span || span.start >= position
      })
    if (!boundary(at)) {
      const first = parses[0]
      const initial = at
      at = 0
      if (first.ok) {
        for (const span of first.spans) {
          const end = span.end
          if (end >= initial && boundary(end)) {
            at = end
            break
          }
        }
      }
    }
    return { ...node, at }
  })
  for (let index = nodes.length - 2; index >= 0; index--) {
    nodes[index].at = Math.min(nodes[index].at, nodes[index + 1].at)
  }
  return {
    ...choices,
    nodes
  }
}

export function demoteActionArgumentChoices<T extends ArgumentDocument>(document: T): T {
  return {
    ...document,
    agentArgs: lowerActionArgumentChoices(document),
    argumentChoices: undefined
  }
}
