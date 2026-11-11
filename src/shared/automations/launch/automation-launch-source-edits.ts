import type { AgentChoicePatch } from '../../agent-launch/choices/agent-launch-choices'
import type {
  AutomationArgumentEdit,
  AutomationLaunchSetup,
  AutomationLaunchPreferences,
  AutomationLaunchSetupPatch
} from './automation-launch-types'
import {
  automationArgumentChoices,
  patchAutomationArguments,
  patchAutomationChoices
} from './automation-launch-choices'
import { patchAutomationLegacyArguments } from './automation-legacy-arguments'
import {
  hasExtraAgentArgs,
  parseExtraAgentArgs
} from '../../agent-launch/startup/automation-extra-agent-args'
import type { TuiAgent } from '../../agent-launch/catalog/tui-agent'
import { isAgentPermissionChoice } from '../../agent-launch/permissions/tui-agent-permission-choice'

export type AutomationLaunchEdit = AutomationLaunchSetupPatch & { legacyOnly?: true }
export type AutomationSourceEdit =
  | { kind: 'arguments'; value: AutomationArgumentEdit }
  | { kind: 'choices'; value: AgentChoicePatch }
  | { kind: 'legacy'; value: string }
  | { kind: 'supplemental'; value: string }

export function encodeAutomationLaunchEdit(
  edit: AutomationLaunchEdit,
  surface: 'chat' | 'terminal'
): AutomationLaunchSetupPatch {
  const { legacyOnly, ...patch } = edit
  return legacyOnly && patch.sources?.legacyArguments !== undefined
    ? { surface, arguments: { kind: 'legacy-extras', value: patch.sources.legacyArguments } }
    : { ...patch, surface }
}

function preferenceEntries(setup: AutomationLaunchSetup): Record<string, string | null> {
  const prefs = setup.launchPreferences
  return {
    ...(prefs?.model !== undefined ? { model: prefs.model } : {}),
    ...(prefs?.permissionMode !== undefined ? { permissionMode: prefs.permissionMode } : {}),
    ...Object.fromEntries(
      Object.entries(prefs?.options ?? {}).map(([key, value]) => [`options.${key}`, value])
    )
  }
}

function writeChoice(patch: AgentChoicePatch, key: string, value: string | null | undefined) {
  if (key === 'model') {
    if (value === undefined) {
      delete patch.model
    } else {
      patch.model = value
    }
  } else if (key === 'permissionMode') {
    if (value === undefined) {
      delete patch.permissionMode
    } else if (value === 'default' || isAgentPermissionChoice(value)) {
      patch.permissionMode = value
    }
  } else {
    patch.options ??= {}
    if (value === undefined) {
      delete patch.options[key.slice(8)]
    } else {
      patch.options[key.slice(8)] = value
    }
  }
}

/** Retirement cuts superseded source carriers; authored replacements are installed afterward. */
export function retireAutomationChoiceSources(
  agent: TuiAgent,
  setup: AutomationLaunchSetup,
  keys: readonly string[]
): AutomationLaunchSetup {
  if (!keys.length) {
    return setup
  }
  const patch: AgentChoicePatch = {}
  for (const key of keys) {
    writeChoice(patch, key, key === 'permissionMode' ? 'default' : null)
  }
  const retired = patchAutomationChoices(agent, setup, patch)
  const preferences = retired.launchPreferences!
  const next: AutomationLaunchPreferences = { ...preferences, options: { ...preferences.options } }
  for (const key of keys) {
    if (key === 'model') {
      delete next.model
    } else if (key === 'permissionMode') {
      delete next.permissionMode
    } else if (next.options) {
      delete next.options[key.slice(8)]
    }
  }
  if (!Object.keys(next.options ?? {}).length) {
    delete next.options
  }
  return { ...retired, launchPreferences: next }
}

export function foldAutomationSourceEdit(
  agent: TuiAgent,
  current: AutomationLaunchSetup,
  previous: AutomationLaunchEdit | undefined,
  edit: AutomationSourceEdit
): { setup: AutomationLaunchSetup; patch: AutomationLaunchEdit } {
  const sources = { ...previous?.sources }
  const choices: AgentChoicePatch = {
    ...previous?.choices,
    options: { ...previous?.choices?.options }
  }
  const retired = new Set(sources.retiredChoices)
  let setup = current
  const touched = new Set<string>()
  const before = preferenceEntries(current)
  const priorArgument = previous?.arguments
  if (priorArgument?.kind === 'legacy-extras') {
    sources.legacyArguments = priorArgument.value
  } else if (priorArgument) {
    sources.arguments = priorArgument
  }

  if (edit.kind === 'arguments') {
    setup = patchAutomationArguments(agent, current, edit.value)
    sources.arguments = edit.value
    delete sources.extraAgentArgs
    delete sources.legacyArguments
    for (const occurrence of automationArgumentChoices(agent, setup.agentArgs ?? '').recognized) {
      touched.add(
        ['model', 'permissionMode'].includes(occurrence.key)
          ? occurrence.key
          : `options.${occurrence.key}`
      )
    }
    setup = {
      ...setup,
      launchPreferences: retireAutomationChoiceSources(agent, setup, [...touched]).launchPreferences
    }
  } else if (edit.kind === 'choices') {
    setup = patchAutomationChoices(agent, current, edit.value)
    if (edit.value.model !== undefined) {
      touched.add('model')
    }
    if (edit.value.permissionMode !== undefined) {
      touched.add('permissionMode')
    }
    for (const key of Object.keys(edit.value.options ?? {})) {
      touched.add(`options.${key}`)
    }
  } else if (edit.kind === 'supplemental') {
    setup = { ...current, extraAgentArgs: hasExtraAgentArgs(edit.value) ? edit.value : undefined }
    sources.extraAgentArgs = edit.value
  } else {
    sources.legacyArguments = edit.value
    // Invalid intermediate text remains pending; absence of parsed spans is not a removal.
    if (
      !hasExtraAgentArgs(edit.value) ||
      parseExtraAgentArgs({ agent, extraAgentArgs: edit.value }).ok
    ) {
      const priorRaw = automationArgumentChoices(agent, current.agentArgs ?? '').recognized
      setup = patchAutomationLegacyArguments(agent, current, edit.value)
      const nextRaw = automationArgumentChoices(agent, setup.agentArgs ?? '').recognized
      for (const { key } of priorRaw) {
        if (['model', 'effort'].includes(key) && !nextRaw.some((entry) => entry.key === key)) {
          touched.add(key === 'model' ? key : `options.${key}`)
        }
      }
      sources.extraAgentArgs = setup.extraAgentArgs ?? ''
      if (sources.arguments) {
        delete sources.legacyArguments
      }
    }
  }
  const after = preferenceEntries(setup)
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (before[key] !== after[key]) {
      touched.add(key)
    }
  }
  for (const key of touched) {
    writeChoice(choices, key, after[key])
    if (after[key] === undefined) {
      retired.add(key)
    } else {
      retired.delete(key)
    }
  }
  if (edit.kind === 'choices') {
    // Explicit default permission still owns removal of its carrier in the latest record.
    if (edit.value.permissionMode === 'default') {
      choices.permissionMode = 'default'
    }
  }
  if (sources.arguments) {
    sources.arguments =
      setup.agentArgs === undefined
        ? { kind: 'inherit' }
        : setup.agentArgs === null
          ? { kind: 'empty' }
          : { kind: 'value', value: setup.agentArgs }
  }
  if (sources.extraAgentArgs !== undefined) {
    sources.extraAgentArgs = setup.extraAgentArgs ?? ''
  }
  sources.retiredChoices = [...retired]
  if (!Object.keys(choices.options ?? {}).length) {
    delete choices.options
  }
  const legacyOnly =
    edit.kind === 'legacy' &&
    (previous?.legacyOnly === true ||
      (!previous?.sources &&
        !previous?.choices &&
        !previous?.copy &&
        (!priorArgument || priorArgument.kind === 'legacy-extras')))
  return {
    setup,
    patch: {
      ...(previous?.copy ? { copy: previous.copy } : {}),
      ...(previous?.surface ? { surface: previous.surface } : {}),
      sources,
      ...(Object.keys(choices).length ? { choices } : {}),
      ...(legacyOnly ? { legacyOnly: true } : {})
    }
  }
}
