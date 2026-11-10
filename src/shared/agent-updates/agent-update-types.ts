import * as z from 'zod'
import { isTuiAgent } from '../agent-launch/catalog/tui-agent-config'
import type { TuiAgent } from '../agent-launch/catalog/tui-agent'
import type { AgentVersionScheme } from './agent-version'

export type InstallMethod = 'npm' | 'brew' | 'app-bundle' | 'other'

// Why: `github` reads `releases/latest` `tag_name` minus a leading `v`; `json.field` is a dot path;
// `text-regex` returns capture group 1 of a multiline `pattern` match on the body.
export type LatestSource =
  | { kind: 'npm'; pkg: string; tag?: string }
  | { kind: 'pypi'; pkg: string }
  | { kind: 'github'; repo: string }
  | { kind: 'json'; url: string; field: string }
  | { kind: 'text'; url: string }
  | { kind: 'text-regex'; url: string; pattern: string }

export type UpdateStep =
  | { via: 'self'; args: readonly string[]; when?: readonly InstallMethod[] }
  | { via: 'npm'; pkg: string; when?: readonly InstallMethod[] }
  | { via: 'manual'; command: string; platforms?: readonly NodeJS.Platform[] }

export type AgentUpdateInfo = {
  /** Defaults to `['--version']`. */
  versionArgs?: readonly string[]
  /** Defaults to `'semver'`. */
  scheme?: AgentVersionScheme
  /** Alert only when latest shares the installed major (separate release lines). */
  sameMajorOnly?: boolean
  latest: LatestSource
  update: readonly UpdateStep[]
}

export type AgentUpdateEntry = AgentUpdateInfo | 'unsupported' | { followsAgent: TuiAgent }

type AgentUpdateRunStatus =
  | { state: 'running' }
  | { state: 'done' }
  | { state: 'failed'; message: string }

type AgentUpdateAction = { kind: 'run' } | { kind: 'manual'; command: string }

export type AgentUpdateRow = {
  agent: TuiAgent
  current: string
  latest: string
  updateAvailable: boolean
  action: AgentUpdateAction
  run: AgentUpdateRunStatus | null
}

export type AgentUpdatesState = {
  rows: AgentUpdateRow[]
  checking: boolean
  checkedAt: number | null
}

export const AgentUpdateRequestSchema = z.object({
  agents: z
    .array(z.string().refine(isTuiAgent, { message: 'Unknown agent' }))
    .min(1, 'Select at least one agent')
})

export type AgentUpdateRequest = z.infer<typeof AgentUpdateRequestSchema>
