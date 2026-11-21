import { z } from 'zod'
import { PLUGIN_ENUM_SINCE_KEY } from '../manifest/plugin-engine-floor-keys'
import {
  pluginFieldDoc,
  PLUGIN_HOOKS_SINCE,
  PLUGIN_LAUNCH_HOOK_KINDS_SINCE
} from '../manifest/plugin-schema-field-docs'

/** Points where a worker can change or stop what Orca is about to do. Closed set: Orca waits
 *  only on plugins whose manifest lists the hook. */
export const PLUGIN_HOOK_NAMES = [
  'terminal.send',
  'workspace.create.before',
  'workspace.create.after',
  'agent.launch.before',
  'agent.prompt.before',
  'agent.tool.before',
  'agent.tool.after',
  'editor.save.before'
] as const
export const PLUGIN_HOOK_LIMIT = PLUGIN_HOOK_NAMES.length

export type PluginHookName = (typeof PLUGIN_HOOK_NAMES)[number]

/** The release each hook arrived in; engines.orca must cover every one a plugin lists. */
export const PLUGIN_HOOK_SINCE: Record<PluginHookName, string> = {
  'terminal.send': PLUGIN_HOOKS_SINCE,
  'workspace.create.before': PLUGIN_HOOKS_SINCE,
  'workspace.create.after': PLUGIN_HOOKS_SINCE,
  'agent.launch.before': PLUGIN_HOOKS_SINCE,
  'agent.prompt.before': PLUGIN_HOOKS_SINCE,
  'agent.tool.before': PLUGIN_HOOKS_SINCE,
  'agent.tool.after': PLUGIN_HOOKS_SINCE,
  'editor.save.before': PLUGIN_HOOKS_SINCE
}

/** RPC error code for an action a plugin hook refused; `data` names the plugin and its reason. */
export const PLUGIN_HOOK_DENIED_CODE = 'denied_by_plugin'

export function isPluginHookName(name: string): name is PluginHookName {
  return PLUGIN_HOOK_NAMES.some((hook) => hook === name)
}

/**
 * How an agent session starts: `new` (a fresh launch), `resume` (an earlier session continued in a new
 * terminal, e.g. the Resume action) or `restore` (Orca reopening a session it saved for a pane: at start,
 * when a sleeping pane wakes, or on restart).
 */
export const AGENT_LAUNCH_KINDS = ['new', 'resume', 'restore'] as const
export type AgentLaunchKind = (typeof AGENT_LAUNCH_KINDS)[number]

export const pluginHookContributionSchema = z
  .object({
    event: z.enum(PLUGIN_HOOK_NAMES).meta({
      ...pluginFieldDoc('Hook the worker handles with `orca.hooks.on`.', PLUGIN_HOOKS_SINCE),
      [PLUGIN_ENUM_SINCE_KEY]: PLUGIN_HOOK_SINCE
    }),
    onError: z
      .enum(['pass', 'deny'])
      .optional()
      .meta(
        pluginFieldDoc(
          "What Orca does when this plugin's hook throws, times out, crashes or does not start: `pass` (the default) carries on as if it passed; `deny` refuses the action, naming the plugin, so a guard fails closed. Ignored for hooks that only observe.",
          PLUGIN_HOOKS_SINCE
        )
      ),
    launchKinds: z
      .array(z.enum(AGENT_LAUNCH_KINDS))
      .min(1)
      .refine((kinds) => new Set(kinds).size === kinds.length, 'list each launch kind once')
      .optional()
      .meta(
        pluginFieldDoc(
          'For `agent.launch.before` only: which starts Orca waits on this plugin for. `new` is a fresh launch, `resume` an earlier session continued in a new terminal (e.g. the Resume action), `restore` Orca reopening a session it saved for a pane (at start, when a sleeping pane wakes, or on restart). Without the field a plugin sees `new` only; a list replaces that default, so `["resume"]` alone stops it running on new launches. A resume or restore that Orca can tell only reattaches to a running session starts no process and is not hooked (best effort: a session that exits during the start is not re-checked). On `resume` and `restore` Orca keeps its own command (a changed `command` is ignored and logged) and applies `env`; the kind comes from the caller, so a plugin that enforces a command policy there must deny rather than rewrite.',
          PLUGIN_LAUNCH_HOOK_KINDS_SINCE,
          [['new', 'resume', 'restore']]
        )
      )
  })
  .strict()
  .refine((hook) => hook.launchKinds === undefined || hook.event === 'agent.launch.before', {
    message: '`launchKinds` applies only to `agent.launch.before`',
    path: ['launchKinds']
  })
  .meta({
    id: 'HookContribution',
    description:
      'A hook Orca runs through the worker before (or after) it acts. Requires `main` and the `trusted-worker` execution profile.'
  })

export type PluginHookContribution = z.infer<typeof pluginHookContributionSchema>

type HookEntry = { event: string; launchKinds?: readonly AgentLaunchKind[] }

/** A launch event's kind; absent (an event written before the field) is `new`. */
function launchKindIn(payload: unknown): AgentLaunchKind {
  const value =
    typeof payload === 'object' && payload !== null && 'launchKind' in payload
      ? payload.launchKind
      : undefined
  return AGENT_LAUNCH_KINDS.find((kind) => kind === value) ?? 'new'
}

/** Whether Orca runs this hook entry for `event` with this payload: for `agent.launch.before`, the
 *  entry's `launchKinds` (default `["new"]`) must include the payload's `launchKind`. The one rule
 *  production, `orca plugin dev hook` and `orca/testing` share. */
export function hookEntryRunsFor(
  hook: HookEntry,
  event: PluginHookName,
  payload: unknown
): boolean {
  if (hook.event !== event) {
    return false
  }
  return (
    event !== 'agent.launch.before' || (hook.launchKinds ?? ['new']).includes(launchKindIn(payload))
  )
}

/** The entries of `hooks` Orca runs for `event` with this payload (see `hookEntryRunsFor`). */
export function hookEntriesFor<H extends HookEntry>(
  hooks: readonly H[],
  event: PluginHookName,
  payload: unknown
): H[] {
  return hooks.filter((hook) => hookEntryRunsFor(hook, event, payload))
}
