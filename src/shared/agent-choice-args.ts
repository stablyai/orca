import {
  agentChoiceCliForms,
  permissionOptionInventory,
  analyzeAgentChoiceWords,
  optionName,
  PERMISSION_LAUNCH_GRAMMARS
} from './agent-permission-args'
import { agentPermissionArgs } from './tui-agent-permission-choice'
import { readAgentChoiceSettings, agentChoiceSettingsOccurrences } from './agent-choice-settings'
import { quoteStartupArg, tokenizeStartupCommand } from './tui-agent-startup-shell'
import type { TuiAgent } from './tui-agent'
import { agentChoiceConfigValue } from './agent-choice-cli-apply'

type ChoiceOccurrence = {
  key: string
  value: string
  start: number
  end: number
  lift: boolean
  owned: boolean
  replacement?: string
}

/** All candidates and cuts refer to the same original text in every execution grammar. */
export function analyzeAgentChoiceArgs(agent: TuiAgent, text: string) {
  const forms = agentChoiceCliForms(agent)
  const inventory = permissionOptionInventory(agent)
  const originals = PERMISSION_LAUNCH_GRAMMARS.map((shell) => {
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
            replacement = `${name} ${quoteStartupArg(JSON.stringify(remaining), 'posix')}`
            value = String(choice)
          }
          if (form.kind === 'config') {
            const configValue = agentChoiceConfigValue(value, form.key)
            if (configValue === undefined) {
              continue
            }
            value = configValue
            lift &&=
              /^[A-Za-z_][A-Za-z0-9_./:-]*$/.test(value) && !/^(true|false|inf|nan)$/i.test(value)
          }
        }
        const spans = first.parsed.spans.slice(index, index + count)
        const start = spans[0].start
        const end = spans.at(-1)?.end ?? start
        const agreed = originals.every((original) => {
          if (!original) {
            return false
          }
          const at = original.offsets.get(start) ?? -1
          return (
            at >= 0 &&
            original.parsed.spans[at + count - 1]?.end === end &&
            spans.every(
              (_, offset) =>
                !original.parsed.spans[at + offset]?.divergesFromShell &&
                original.parsed.tokens[at + offset] === first.parsed.tokens[index + offset]
            ) &&
            (original.analysis.optionIndices.has(at) || (key === 'permissionMode' && at === 0)) &&
            (key !== 'permissionMode' ||
              original.analysis.carrierIndices.every(
                (carrier) => carrier >= at && carrier < at + count
              ))
          )
        })
        if (!seen.has(`${key}:${start}`)) {
          seen.add(`${key}:${start}`)
          occurrences.push({
            key,
            value,
            start,
            end,
            lift: lift && agreed,
            owned: agreed,
            ...(replacement !== undefined ? { replacement } : {})
          })
        }
      }
    }
  }
  const cut = (selected: readonly ChoiceOccurrence[]): string | null => {
    if (!first || !selected.length) {
      return selected.length ? null : text
    }
    const ranges = [...selected].sort((a, b) => a.start - b.start)
    if (ranges.some((range, index) => index > 0 && range.start < ranges[index - 1].end)) {
      return null
    }
    const replacements = new Map(
      ranges.filter((range) => range.replacement).map((range) => [range.start, range.replacement])
    )
    const chunks: string[] = []
    let cursor = 0
    for (const { start, end, replacement } of ranges) {
      chunks.push(text.slice(cursor, start), replacement ?? '')
      cursor = end
    }
    chunks.push(text.slice(cursor))
    const args = chunks.join('').trim()
    const proven = originals.every((original, grammarIndex) => {
      if (!original) {
        return false
      }
      let rangeIndex = 0
      const removed = original.parsed.spans.map((span) => {
        while (rangeIndex < ranges.length && ranges[rangeIndex].end <= span.start) {
          rangeIndex++
        }
        const range = ranges[rangeIndex]
        return !!range && span.start >= range.start && span.end <= range.end
      })
      const kept = original.parsed.tokens.filter((_, index) => !removed[index])
      const expected = original.parsed.tokens.flatMap((token, index) => {
        if (!removed[index]) {
          return [token]
        }
        const text = replacements.get(original.parsed.spans[index].start)
        if (!text) {
          return []
        }
        const replacement = tokenizeStartupCommand(text, PERMISSION_LAUNCH_GRAMMARS[grammarIndex])
        return replacement.ok ? replacement.tokens : []
      })
      const parsed = tokenizeStartupCommand(args, PERMISSION_LAUNCH_GRAMMARS[grammarIndex])
      if (
        !parsed.ok ||
        expected.length !== parsed.tokens.length ||
        !expected.every((token, index) => token === parsed.tokens[index])
      ) {
        return false
      }
      const prefix = original.parsed.tokens.filter((_, index) => removed[index])
      const composed = analyzeAgentChoiceWords(agent, [...prefix, ...kept], inventory)
      const roles = original.analysis.roles.filter((_, index) => !removed[index])
      const leading = removed.slice(0, removed.lastIndexOf(true) + 1).every(Boolean)
      return (
        leading ||
        (!original.analysis.roles.includes('uncertain') &&
          roles.every((role, index) => role === composed.roles[prefix.length + index]))
      )
    })
    return proven ? args : null
  }
  return { occurrences, cut, opaqueKeys }
}
