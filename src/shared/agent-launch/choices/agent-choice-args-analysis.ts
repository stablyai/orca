import { cutAgentChoiceArgs } from './agent-choice-argument-cut'
import {
  agentChoiceCliForms,
  permissionOptionInventory,
  analyzeAgentChoiceWords,
  optionName
} from '../permissions/agent-permission-args'
import { agentPermissionArgs } from '../permissions/tui-agent-permission-choice'
import { readAgentChoiceSettings, agentChoiceSettingsOccurrences } from './agent-choice-settings'
import {
  quoteStartupArg,
  tokenizeStartupCommand,
  type AgentStartupShell
} from '../startup/tui-agent-startup-shell'
import type { TuiAgent } from '../catalog/tui-agent'
import type { ChoiceOccurrence } from './agent-launch-choices'
import { agentChoiceConfigString, agentChoiceConfigValue } from './agent-choice-cli-apply'

export type { ChoiceOccurrence } from './agent-launch-choices'

/** Every cut uses the original spans and preserves operand roles in its consuming grammar. */
export function analyzeChoiceArgs(
  agent: TuiAgent,
  text: string,
  grammars: readonly AgentStartupShell[],
  generatedCarriers?: readonly ChoiceOccurrence[]
) {
  const forms = agentChoiceCliForms(agent)
  const inventory = permissionOptionInventory(agent)
  const originals = grammars.map((shell) => {
    const parsed = tokenizeStartupCommand(text, shell)
    return parsed.ok
      ? {
          parsed,
          analysis: analyzeAgentChoiceWords(agent, parsed.tokens, inventory),
          offsets: new Map(parsed.spans.map((span, index) => [span.start, index]))
        }
      : null
  })
  const first = originals[0]
  const occurrences: ChoiceOccurrence[] = []
  const seen = new Set<string>()
  const opaqueKeys = new Set<string>()
  const effectiveSettings = new Map<
    (typeof forms)[number]['form'],
    ReturnType<typeof agentChoiceSettingsOccurrences>[number] | undefined
  >()
  for (const { key, form } of forms) {
    if (form.kind !== 'settings') {
      continue
    }
    const effective = first
      ? agentChoiceSettingsOccurrences(agent, form.names, first.parsed.tokens).at(-1)
      : undefined
    effectiveSettings.set(form, effective)
    if (
      !first ||
      (effective &&
        (!readAgentChoiceSettings(effective.value) ||
          !first.analysis.optionIndices.has(effective.index) ||
          first.analysis.roles[effective.index] === 'uncertain' ||
          !originals.every((original) => {
            if (!original) {
              return false
            }
            const start = first.parsed.spans[effective.index].start
            const at = original.offsets.get(start) ?? -1
            return (
              at >= 0 &&
              Array.from({ length: effective.consumed }, (_, offset) => offset).every(
                (offset) =>
                  original.parsed.spans[at + offset]?.end ===
                    first.parsed.spans[effective.index + offset].end &&
                  original.parsed.tokens[at + offset] ===
                    first.parsed.tokens[effective.index + offset]
              )
            )
          })))
    ) {
      opaqueKeys.add(key)
    }
  }
  if (first && originals.every((original) => original !== null)) {
    for (let index = 0; index < first.parsed.tokens.length; index++) {
      const token = first.parsed.tokens[index]
      if (
        first.analysis.roles[index]?.startsWith('value:') ||
        first.analysis.roles[index] === 'positional' ||
        first.analysis.roles[index] === 'terminator'
      ) {
        continue
      }
      for (const { key, form } of forms) {
        let count = 1
        let value = ''
        let valueType: ChoiceOccurrence['valueType'] = 'string'
        let lift = false
        let replacement: string | undefined
        if (form.kind === 'recipe') {
          count = form.words.length
          if (!form.words.every((word, offset) => first.parsed.tokens[index + offset] === word)) {
            continue
          }
          value = form.value
          const recipe = agentPermissionArgs(agent, form.value)
          const parsedRecipe = tokenizeStartupCommand(recipe, 'posix')
          lift =
            parsedRecipe.ok &&
            parsedRecipe.spans.every(
              (span, offset) =>
                text.slice(
                  first.parsed.spans[index + offset].start,
                  first.parsed.spans[index + offset].end
                ) === recipe.slice(span.start, span.end)
            )
        } else {
          const name = optionName(agent, token)
          if (!form.names.includes(name)) {
            continue
          }
          const inline = token !== name
          value = inline
            ? token.slice(name.length + (token[name.length] === '=' ? 1 : 0))
            : (first.parsed.tokens[index + 1] ?? '')
          count = !inline && first.analysis.roles[index + 1] === `value:${name}` ? 2 : 1
          lift =
            form.lift !== 'never' &&
            (!inline || name.startsWith('--')) &&
            !!value &&
            !value.startsWith('-')
          if (form.kind === 'value' && form.recognizes?.(value) === false) {
            valueType = undefined
            lift = false
          }
          if (form.kind === 'settings') {
            const effective = effectiveSettings.get(form)
            if (effective?.index !== index || opaqueKeys.has(key)) {
              continue
            }
            const settings = readAgentChoiceSettings(value)
            const choice = settings?.[form.key]
            if (!settings || (typeof choice !== 'boolean' && typeof choice !== 'string')) {
              continue
            }
            const { [form.key]: _removed, ...remaining } = settings
            replacement = `${name} ${quoteStartupArg(JSON.stringify(remaining), grammars[0])}`
            value = String(choice)
            valueType = typeof choice === 'boolean' ? 'boolean' : 'string'
          }
          if (form.kind === 'config') {
            const configValue = agentChoiceConfigValue(value, form.key)
            if (configValue === undefined) {
              continue
            }
            const decoded = agentChoiceConfigString(configValue)
            valueType = decoded === undefined ? undefined : 'string'
            value = decoded ?? configValue
            lift &&= decoded !== undefined
          }
        }
        const spans = first.parsed.spans.slice(index, index + count)
        const start = spans[0].start
        const end = spans.at(-1)?.end ?? start
        const words = first.parsed.tokens.slice(index, index + count)
        const currentGeneratedCarrier =
          generatedCarriers?.some(
            (entry) =>
              entry.key === key &&
              entry.value === value &&
              entry.valueType === valueType &&
              entry.words.length === words.length &&
              entry.words[0] === words[0] &&
              spans.every(
                (span, offset) =>
                  !span.divergesFromShell ||
                  text.slice(span.start, span.end) === quoteStartupArg(words[offset], grammars[0])
              )
          ) ?? false
        const sourceAgreed = originals.every((original, grammarIndex) => {
          if (!original) {
            return false
          }
          const at = original.offsets.get(start) ?? -1
          return (
            at >= 0 &&
            original.parsed.spans[at + count - 1]?.end === end &&
            spans.every(
              (_, offset) =>
                (grammars[grammarIndex] === 'cmd' ||
                  !original.parsed.spans[at + offset]?.divergesFromShell ||
                  currentGeneratedCarrier) &&
                original.parsed.tokens[at + offset] === first.parsed.tokens[index + offset]
            ) &&
            (original.analysis.optionIndices.has(at) || (key === 'permissionMode' && at === 0)) &&
            (key !== 'permissionMode' ||
              original.analysis.carrierIndices.every(
                (carrier) => carrier >= at && carrier < at + count
              ))
          )
        })
        const agreed =
          sourceAgreed &&
          originals.every(
            (original) =>
              original &&
              spans.every((span) => {
                const at = original.offsets.get(span.start)
                return (
                  at !== undefined &&
                  (!original.parsed.spans[at].divergesFromShell || currentGeneratedCarrier)
                )
              })
          )
        if (!seen.has(`${key}:${start}`)) {
          seen.add(`${key}:${start}`)
          occurrences.push({
            key,
            value,
            valueType,
            words,
            start,
            end,
            lift: lift && agreed,
            owned: agreed,
            source: sourceAgreed && valueType !== undefined,
            ...(replacement !== undefined ? { replacement } : {})
          })
        }
      }
    }
  }
  const cut = (
    selected: readonly Pick<ChoiceOccurrence, 'start' | 'end' | 'replacement'>[],
    purpose?: 'delete'
  ) =>
    cutAgentChoiceArgs({
      agent,
      text,
      grammars,
      originals,
      occurrences,
      inventory,
      selected,
      purpose
    })

  return { occurrences, cut, opaqueKeys }
}
