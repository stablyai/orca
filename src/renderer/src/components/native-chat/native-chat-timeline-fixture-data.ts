// Shared data for the timeline row fixtures: a teammate on this computer and its answers.
import { publishBots } from '@/lib/bot-catalog-snapshot'
import type { Bot } from '../../../../shared/bot-types'

export const FIXTURE_AT = Date.parse('2026-11-14T18:12:00Z')

export function fixtureTeammate(id: string, name: string): Bot {
  return {
    id,
    name,
    hostId: 'local',
    folder: id,
    folderWorkspaceId: `fw-${id}`,
    agent: 'claude',
    avatar: null,
    paused: false,
    notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
    members: [],
    slack: null,
    linear: null,
    github: null,
    chatSessionId: `chat-${id}`,
    createdAt: 1,
    updatedAt: 1
  }
}

/** A string field of a runtime call's params, or '' when it has none. */
export function fixtureParam(params: unknown, field: string): string {
  if (typeof params !== 'object' || params === null) {
    return ''
  }
  const value = Object.entries(params).find(([key]) => key === field)?.[1]
  return typeof value === 'string' ? value : ''
}

/** Lists `teammates` and answers `answers[method]` for the runtime calls the rows make. */
export function installFixtureTeammates(
  teammates: readonly Bot[],
  answers: Record<string, (params: unknown) => unknown>
): void {
  publishBots(teammates)
  const all: Record<string, (params: unknown) => unknown> = {
    'bots.list': () => ({ bots: teammates }),
    ...answers
  }
  const call = window.api.runtime.call
  window.api.runtime.call = async (args) => {
    const answer = all[args.method]
    return answer
      ? { id: args.method, ok: true, _meta: { runtimeId: 'fixture' }, result: answer(args.params) }
      : call(args)
  }
}
