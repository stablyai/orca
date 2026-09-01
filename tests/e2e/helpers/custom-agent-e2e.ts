import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import type {
  AgentLaunchSourceRecord,
  AgentLaunchSpawnRequest
} from '../../../src/shared/agent-launch-spawn-request'
import type { LaunchSource } from '../../../src/shared/telemetry-events'
import type { BuiltInTuiAgent, CustomTuiAgent, CustomTuiAgentId } from '../../../src/shared/types'
import { expect } from './orca-app'

// Shared scaffolding for the custom-agent launch-surface e2e specs. Each surface
// (Cmd+N composer, new tab, annotations, git actions) converges on the SAME
// client contract — an empty command plus an `agentLaunch` selection the host
// resolves at spawn — so the specs differ only in the surface-specific params
// (launch_source, sourceRecord, prompt/promptDelivery). This helper centralizes
// the seed shape, the seed self-verification, and the boundary launch so the
// specs stay readable and a schema drift fails loudly in one place.

/** The seeded custom agent's executable is `node <fixture>`: commandOverride is
 *  the node binary (one argv element) and the fixture path rides the v1 args
 *  template (space-free, so it tokenizes to a single argument). */
export const FIXTURE_PATH = path.join(
  process.cwd(),
  'tests/e2e/fixtures/custom-agent-launch-fixture.cjs'
)

/** Markers the deterministic fixture prints; a spec asserts on these to prove the
 *  host resolved the custom executable and drove input into THIS process. */
export const READY_MARKER = 'CUSTOM_AGENT_FIXTURE_READY'
export const ECHO_PREFIX = 'CUSTOM_AGENT_ECHO:'
export const ARGV_PREFIX = 'CUSTOM_AGENT_ARGV:'

/** Build a seeded custom-agent definition. Each spec passes a unique uuid so a
 *  human reading a failing catalog snapshot can tell which spec seeded it. */
export function buildCustomAgent(options: {
  uuid: string
  label: string
  baseAgent?: BuiltInTuiAgent
  args?: string
  env?: Record<string, string>
  syncEnv?: boolean
}): CustomTuiAgent {
  const baseAgent = options.baseAgent ?? 'codex'
  return {
    id: `custom-agent:${baseAgent}:${options.uuid}` as CustomTuiAgentId,
    baseAgent,
    label: options.label,
    commandOverride: process.execPath,
    args: options.args ?? FIXTURE_PATH,
    env: options.env ?? {},
    syncEnv: options.syncEnv ?? false
  }
}

/** Self-verify a seed loaded into the real host catalog as a `ready` entry before
 *  launching, so schema drift fails loudly here instead of silently no-op'ing. */
export async function expectCustomAgentSeeded(
  page: Page,
  agentId: CustomTuiAgentId,
  expectedLabel: string
): Promise<void> {
  const loadedAgent = await page.evaluate(async (id) => {
    const snapshot = await window.api.settings.agentCatalog.getLocal()
    const entry = snapshot.customAgents.find(
      (candidate) => candidate.status === 'ready' && candidate.definition.id === id
    )
    return entry && entry.status === 'ready'
      ? { id: entry.definition.id, label: entry.definition.label }
      : null
  }, agentId)
  expect(loadedAgent).toEqual({ id: agentId, label: expectedLabel })
}

export type BoundaryLaunchOptions = {
  worktreeId: string
  agentId: CustomTuiAgentId
  /** The real surface's telemetry launch_source (e.g. 'new_workspace_composer'). */
  launchSource: LaunchSource
  /** Host-verified owner locator; drives recipe agentArgs into perLaunchArgs. */
  sourceRecord?: AgentLaunchSourceRecord
  /** Interactive draft folded into the launch (quick-launch / draft surfaces). */
  prompt?: string
  /** 'draft' lands the prompt unsubmitted; default is the host 'submit' policy. */
  promptDelivery?: 'submit' | 'draft'
}

/** Launch a seeded custom agent through the exact production boundary every
 *  surface funnels into (createTab → queueTabStartupCommand with an `agentLaunch`
 *  selection the host resolves at spawn). Returns the launched tab id. When a
 *  `prompt` is given it folds into the launch; otherwise the tab launches bare
 *  with allowEmptyPromptLaunch, matching the surfaces that paste post-ready. */
export async function launchCustomAgentViaBoundary(
  page: Page,
  options: BoundaryLaunchOptions
): Promise<string> {
  return await page.evaluate((opts) => {
    const store = window.__store
    if (!store) {
      throw new Error('Store unavailable')
    }
    const state = store.getState()
    const tab = state.createTab(opts.worktreeId, undefined, undefined, {
      launchAgent: opts.agentId
    })
    const agentLaunch: AgentLaunchSpawnRequest = {
      selection: { kind: 'agent', agent: opts.agentId },
      ...(opts.prompt
        ? {
            prompt: opts.prompt,
            ...(opts.promptDelivery === 'draft' ? { promptDelivery: 'draft' as const } : {})
          }
        : { allowEmptyPromptLaunch: true }),
      ...(opts.sourceRecord ? { sourceRecord: opts.sourceRecord } : {})
    }
    state.queueTabStartupCommand(tab.id, {
      command: '',
      agentLaunch,
      telemetry: { launch_source: opts.launchSource, request_kind: 'new' }
    })
    state.setActiveTab(tab.id)
    state.setActiveTabType('terminal')
    return tab.id
  }, options)
}

/** Read a launched tab's visible launch identity (launchAgent + ptyId) so a spec
 *  can assert the pane carries the custom agent's identity and a real PTY. */
export async function readTabLaunchIdentity(
  page: Page,
  worktreeId: string,
  tabId: string
): Promise<{ launchAgent: string | undefined; ptyId: string | null } | null> {
  return await page.evaluate(
    ({ worktreeId, tabId }) => {
      const tab = (window.__store?.getState().tabsByWorktree[worktreeId] ?? []).find(
        (candidate) => candidate.id === tabId
      )
      return tab ? { launchAgent: tab.launchAgent, ptyId: tab.ptyId } : null
    },
    { worktreeId, tabId }
  )
}
