import type { TuiAgent } from './types'
import { isTuiAgent } from './tui-agent-config'

export type CustomAgentId = `custom:${string}`
export type AgentId = TuiAgent | CustomAgentId

export type CustomAgentPromptMode = 'pty' | 'argv' | 'template'

export type CustomAgentIcon =
  | { kind: 'terminal' }
  | { kind: 'letter'; value: string }
  | { kind: 'image'; dataUrl: string; fileName: string }

export type CustomAgentDefinition = {
  id: CustomAgentId
  name: string
  command: string
  promptMode: CustomAgentPromptMode
  promptTemplate?: string
  icon: CustomAgentIcon
  enabled: boolean
}

const CUSTOM_AGENT_ID_PATTERN = /^custom:[a-z0-9][a-z0-9-]{0,63}$/
const MAX_CUSTOM_AGENT_NAME_LENGTH = 80
const MAX_CUSTOM_AGENT_COMMAND_LENGTH = 2000
const MAX_CUSTOM_AGENT_TEMPLATE_LENGTH = 4000
const MAX_CUSTOM_AGENT_IMAGE_DATA_URL_LENGTH = 350_000

export function isCustomAgentId(value: unknown): value is CustomAgentId {
  return typeof value === 'string' && CUSTOM_AGENT_ID_PATTERN.test(value)
}

export function isAgentId(value: unknown): value is AgentId {
  return isTuiAgent(value) || isCustomAgentId(value)
}

export function normalizeAgentIds(value: unknown): AgentId[] {
  if (!Array.isArray(value)) {return []}
  const seen = new Set<string>()
  const result: AgentId[] = []
  for (const item of value) {
    if (isAgentId(item) && !seen.has(item)) {
      seen.add(item)
      result.push(item)
    }
  }
  return result
}

export function createCustomAgentId(name: string, existing: Iterable<string> = []): CustomAgentId {
  const stem = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'agent'
  const used = new Set(existing)
  let candidate = `custom:${stem}`
  let suffix = 2
  while (used.has(candidate)) {
    candidate = `custom:${stem}-${suffix++}`
  }
  return candidate as CustomAgentId
}

export function normalizeCustomAgents(value: unknown): CustomAgentDefinition[] {
  if (!Array.isArray(value)) {return []}
  const seen = new Set<string>()
  const normalized: CustomAgentDefinition[] = []
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object') {continue}
    const item = candidate as Partial<CustomAgentDefinition>
    if (!isCustomAgentId(item.id) || seen.has(item.id)) {continue}
    const name = typeof item.name === 'string' ? item.name.trim().slice(0, MAX_CUSTOM_AGENT_NAME_LENGTH) : ''
    const command = typeof item.command === 'string' ? item.command.trim().slice(0, MAX_CUSTOM_AGENT_COMMAND_LENGTH) : ''
    if (!name || !command) {continue}
    const promptMode = item.promptMode === 'argv' || item.promptMode === 'template' ? item.promptMode : 'pty'
    const promptTemplate = typeof item.promptTemplate === 'string'
      ? item.promptTemplate.slice(0, MAX_CUSTOM_AGENT_TEMPLATE_LENGTH)
      : undefined
    if (promptMode === 'template' && (!promptTemplate || !promptTemplate.includes('{prompt}'))) {continue}
    const icon = normalizeCustomAgentIcon(item.icon, name)
    if (!icon) {continue}
    seen.add(item.id)
    normalized.push({
      id: item.id,
      name,
      command,
      promptMode,
      ...(promptTemplate ? { promptTemplate } : {}),
      icon,
      enabled: item.enabled !== false
    })
  }
  return normalized
}

function normalizeCustomAgentIcon(value: unknown, name: string): CustomAgentIcon | null {
  if (!value || typeof value !== 'object') {return { kind: 'letter', value: name.charAt(0).toUpperCase() }}
  const icon = value as Partial<CustomAgentIcon>
  if (icon.kind === 'terminal') {return { kind: 'terminal' }}
  if (icon.kind === 'letter') {
    const letter = typeof icon.value === 'string' ? icon.value.trim().slice(0, 2) : ''
    return { kind: 'letter', value: letter || name.charAt(0).toUpperCase() }
  }
  if (
    icon.kind === 'image' &&
    typeof icon.dataUrl === 'string' &&
    icon.dataUrl.startsWith('data:image/') &&
    icon.dataUrl.length <= MAX_CUSTOM_AGENT_IMAGE_DATA_URL_LENGTH &&
    typeof icon.fileName === 'string'
  ) {
    return { kind: 'image', dataUrl: icon.dataUrl, fileName: icon.fileName.slice(0, 160) }
  }
  return { kind: 'letter', value: name.charAt(0).toUpperCase() }
}

export function isCustomAgentEnabled(
  agent: AgentId,
  customAgents: readonly CustomAgentDefinition[] | null | undefined
): boolean {
  const custom = isCustomAgentId(agent) ? customAgents?.find((item) => item.id === agent) : null
  return custom ? custom.enabled : true
}

export function customAgentForId(
  agent: AgentId,
  customAgents: readonly CustomAgentDefinition[] | null | undefined
): CustomAgentDefinition | undefined {
  return isCustomAgentId(agent) ? customAgents?.find((item) => item.id === agent) : undefined
}
