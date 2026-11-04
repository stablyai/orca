import { getAgentSessionOptionLaunchCatalog } from './agent-session-option-catalog'
import type { AgentChoiceCliForm } from './agent-launch-choices'
import type { AgentPermissionChoice } from './tui-agent-permission-choice'
import { agentRequiredValueOptions } from './agent-session-option-agent-args'
import { agentPermissionArgs, agentPermissionChoices } from './tui-agent-permission-choice'
import { tokenizeStartupCommand, type AgentStartupShell } from './tui-agent-startup-shell'
import type { TuiAgent } from './tui-agent'

export const CODEX_PERMISSION_CONFIG_ROOTS = [
  'approval_policy',
  'sandbox_mode',
  'approvals_reviewer',
  'sandbox_workspace_write'
] as const

const CLAUDE_PERMISSION_OPTIONS = [
  '--permission-mode',
  '--dangerously-skip-permissions',
  '--allow-dangerously-skip-permissions',
  '--permission-prompt-tool',
  '--permission-prompts',
  '--allowedTools',
  '--allowed-tools',
  '--disallowedTools',
  '--disallowed-tools'
]
const EXTRA_CARRIERS: Partial<Record<TuiAgent, readonly string[]>> = {
  claude: CLAUDE_PERMISSION_OPTIONS,
  'claude-agent-teams': CLAUDE_PERMISSION_OPTIONS,
  codex: ['-a', '--ask-for-approval', '-s', '--sandbox', '--yolo', '--not-so-yolo', '--full-auto'],
  grok: ['--permission-mode', '--always-approve', '--yolo', '--dangerously-skip-permissions'],
  gemini: ['--approval-mode', '-y']
}
const CODEX_VALUES = [
  '-a',
  '--ask-for-approval',
  '-s',
  '--sandbox',
  '-c',
  '--config',
  '-m',
  '--model',
  '--local-provider',
  '--enable',
  '--disable'
]
const MODEL_VALUES = ['--model', '--effort']
const CLAUDE_VARIADIC = [
  '--tools',
  '--allowedTools',
  '--allowed-tools',
  '--disallowedTools',
  '--disallowed-tools',
  '--add-dir',
  '--mcp-config',
  '--betas',
  '--plugin-dir'
]
export const PERMISSION_LAUNCH_GRAMMARS: readonly AgentStartupShell[] = [
  'posix',
  'powershell',
  'cmd'
]

function words(text: string): string[] {
  const parsed = tokenizeStartupCommand(text, 'posix')
  return parsed.ok ? parsed.tokens : []
}

export function optionName(agent: TuiAgent, token: string): string {
  if ((agent === 'codex' && /^-[acs].+/.test(token)) || /^-m.+/.test(token)) {
    return token.slice(0, 2)
  }
  return token.split('=', 1)[0]
}

/** Literal CLI roots: shell quoting is already removed; TOML quoted keys are not decoded. */
function isPermissionConfig(value: string | undefined): boolean {
  if (!value?.includes('=')) {
    return false
  }
  const root = value.slice(0, value.indexOf('=')).trim().split('.')[0]
  return CODEX_PERMISSION_CONFIG_ROOTS.some((key) => key === root)
}

type PermissionOptionInventory = {
  values: Set<string>
  carriers: Set<string>
  switches: Set<string>
}
export function permissionOptionInventory(agent: TuiAgent): PermissionOptionInventory {
  const forms = agentChoiceCliForms(agent)
  const recipes = agentPermissionChoices(agent).flatMap((choice) => {
    const tokens = words(agentPermissionArgs(agent, choice))
    return tokens.map((token, index) => ({ token, next: tokens[index + 1] }))
  })
  const carriers = new Set(EXTRA_CARRIERS[agent])
  const values = new Set(agent === 'codex' ? CODEX_VALUES : [])
  const switches = new Set<string>()
  for (const { token, next } of recipes) {
    if (!token.startsWith('-')) {
      continue
    }
    const name = optionName(agent, token)
    if (name !== '-c' && name !== '--config') {
      carriers.add(name)
    }
    if (token === name && next && !next.startsWith('-')) {
      values.add(name)
    } else {
      switches.add(name)
    }
  }
  for (const { form } of forms) {
    if (form.kind !== 'recipe') {
      form.names.forEach((name) => values.add(name))
    }
  }
  return { carriers, values, switches }
}

/** Bounded root-option ownership. Unknown regions stay uncertain, never rejected. */
export function analyzeAgentChoiceWords(
  agent: TuiAgent,
  tokens: readonly string[],
  inventory = permissionOptionInventory(agent)
) {
  const claude = agent === 'claude' || agent === 'claude-agent-teams'
  const required = agentRequiredValueOptions(agent)
  const roles: string[] = []
  const optionIndices = new Set<number>()
  let uncertain = false
  let terminated = false
  const carrierIndices: number[] = []
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (terminated) {
      roles[index] = 'positional'
      continue
    }
    if (token === '--' && !uncertain) {
      roles[index] = 'terminator'
      terminated = true
      continue
    }
    const name = optionName(agent, token)
    const inline = token !== name
    const value = inline
      ? token.slice(name.length + (token[name.length] === '=' ? 1 : 0))
      : tokens[index + 1]
    const policy =
      inventory.carriers.has(name) ||
      (agent === 'codex' && ['-c', '--config'].includes(name) && isPermissionConfig(value))
    if (policy) {
      carrierIndices.push(index)
    }
    const knownValue =
      inventory.values.has(name) ||
      required.includes(name) ||
      (['claude', 'claude-agent-teams', 'grok', 'codex'].includes(agent) &&
        MODEL_VALUES.includes(name))
    const known =
      knownValue ||
      inventory.carriers.has(name) ||
      inventory.switches.has(name) ||
      (agent === 'codex' && ['--search', '--oss', '--no-alt-screen'].includes(name))
    roles[index] = uncertain || !known ? 'uncertain' : `option:${name}`
    if (!uncertain && known) {
      optionIndices.add(index)
    }
    if (!known) {
      uncertain = true
    }
    if (!knownValue || inline || uncertain) {
      continue
    }
    const consumesDash = required.includes(name)
    if (value === undefined || (!consumesDash && value.startsWith('-'))) {
      continue
    }
    roles[++index] = uncertain ? 'uncertain' : `value:${name}`
    if (claude && CLAUDE_VARIADIC.includes(name)) {
      while (tokens[index + 1] !== undefined && !tokens[index + 1].startsWith('-')) {
        roles[++index] = uncertain ? 'uncertain' : `value:${name}`
      }
    }
  }
  return { roles, optionIndices, carrier: carrierIndices.length > 0, carrierIndices }
}

export function agentArgsSetPermission(agent: TuiAgent, text: string | null | undefined): boolean {
  return PERMISSION_LAUNCH_GRAMMARS.some((grammar) => {
    const parsed = tokenizeStartupCommand(text ?? '', grammar)
    return parsed.ok && analyzeAgentChoiceWords(agent, parsed.tokens).carrier
  })
}

export function agentChoiceCliForms(agent: TuiAgent) {
  const catalog = getAgentSessionOptionLaunchCatalog(agent)
  const options = [
    ...(catalog?.unknownModelOptions ?? []),
    ...(catalog?.models.flatMap((model) => model.options) ?? [])
  ]
  const forms: { key: string; form: AgentChoiceCliForm }[] = (catalog?.modelApply.cli ?? []).map(
    (form) => ({ key: 'model', form })
  )
  for (const option of options) {
    for (const form of option.apply.cli ?? []) {
      if (
        !forms.some(
          (entry) => entry.key === option.id && JSON.stringify(entry.form) === JSON.stringify(form)
        )
      ) {
        forms.push({ key: option.id, form })
      }
    }
  }
  for (const value of agentPermissionChoices(agent)) {
    const recipe = words(agentPermissionArgs(agent, value))
    if (recipe.length) {
      forms.push({ key: 'permissionMode', form: { kind: 'recipe', words: recipe, value } })
    }
  }
  return forms
}

export function agentPermissionArgsForLaunch(
  agent: TuiAgent,
  choice: AgentPermissionChoice,
  text: string
): string | null {
  return choice === 'own'
    ? ''
    : agentArgsSetPermission(agent, text)
      ? null
      : agentPermissionArgs(agent, choice)
}
