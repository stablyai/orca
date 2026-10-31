import { parse as parseToml } from 'smol-toml'
import type { AgentType } from './agent-status-types'
import type { AgentChoiceCliForm } from './agent-launch-choices'
import type { CatalogOptionApply } from './agent-session-option-catalog-types'
import { mergeAgentChoiceSettings, withoutInlineAgentChoiceSettings } from './agent-choice-settings'
import { removeAgentArgOption } from './agent-session-option-agent-args'

type ChoiceCliArgumentForm = Exclude<AgentChoiceCliForm, { kind: 'recipe' }>

export function agentChoiceConfigValue(value: string, key: string): string | undefined {
  const separator = value.indexOf('=')
  return separator !== -1 && value.slice(0, separator).trim() === key
    ? value.slice(separator + 1)
    : undefined
}

/** CLI config values are TOML scalars, with invalid TOML falling back to a literal string. */
export function agentChoiceConfigString(value: string): string | undefined {
  try {
    const scalar = parseToml(`value=${value}`)
    return Object.keys(scalar).length === 1 && typeof scalar.value === 'string'
      ? scalar.value
      : undefined
  } catch {
    return value.trim().replace(/^["']+|["']+$/g, '')
  }
}

export function agentChoiceConfigCanonicalString(value: string): string | undefined {
  return /^[A-Za-z_][A-Za-z0-9_./:-]*$/.test(value) && agentChoiceConfigString(value) === value
    ? value
    : undefined
}

function configString(value: string): string {
  return agentChoiceConfigCanonicalString(value) ?? JSON.stringify(value)
}

/** The declared grammar owns both forward spelling and conflicting argument removal. */
export function agentChoiceCliApply(
  agent: AgentType,
  forms: readonly [ChoiceCliArgumentForm, ...ChoiceCliArgumentForm[]],
  emitted: string
): CatalogOptionApply {
  const encoder = forms.find((form) => form.names.includes(emitted)) ?? forms[0]
  return {
    cli: forms,
    launchArgs: (value, trailing = []) =>
      encoder.kind === 'settings'
        ? mergeAgentChoiceSettings(agent, encoder.names, trailing, encoder.key, value)
        : encoder.kind === 'config'
          ? [emitted, `${encoder.key}=${configString(String(value))}`]
          : [emitted, String(value)],
    removeAgentArgs: (tokens) =>
      forms.reduce(
        (kept, form) =>
          form.kind === 'settings'
            ? withoutInlineAgentChoiceSettings(agent, form.names, kept)
            : removeAgentArgOption(
                agent,
                kept,
                form.names,
                form.kind === 'config'
                  ? (value) => agentChoiceConfigValue(value ?? '', form.key) !== undefined
                  : undefined
              ),
        [...tokens]
      )
  }
}
