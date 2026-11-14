import type { AgentSessionReviewTarget } from '../../agent-session/agent-session-review-target'
import type { SessionOptionSelectChoice } from './native-chat-session-options'

export type NativeChatReviewRun = (
  target: AgentSessionReviewTarget,
  instructions?: string
) => Promise<{ accepted: boolean; error: string | null }>
export type NativeChatReviewMenu = ReturnType<typeof createNativeChatReviewMenu>
type ReviewPage = 'review' | 'baseBranch' | 'commit' | 'custom'
type ReviewMenuSnapshot = {
  page: ReviewPage
  choices: readonly SessionOptionSelectChoice[]
  busy: boolean
}

/** Menu data is local to one opening; every git query runs on the chat's host. */
export function createNativeChatReviewMenu(input: {
  hasGit: boolean
  branches: () => Promise<string[]>
  commits: () => Promise<{ id: string; subject: string }[]>
  run: NativeChatReviewRun
  onError: (message: string) => void
}) {
  const root: SessionOptionSelectChoice[] = [
    ...(input.hasGit
      ? [
          { value: 'baseBranch', label: 'Review against a base branch' },
          { value: 'uncommittedChanges', label: 'Review uncommitted changes' },
          { value: 'commit', label: 'Review a commit' }
        ]
      : []),
    { value: 'custom', label: 'Custom review instructions' }
  ]
  let snapshot: ReviewMenuSnapshot = { page: 'review', choices: root, busy: false }
  const listeners = new Set<() => void>()
  const publish = (next: ReviewMenuSnapshot) => {
    snapshot = next
    for (const listener of listeners) {
      listener()
    }
  }
  const run = async (target: AgentSessionReviewTarget, instructions?: string) => {
    publish({ ...snapshot, busy: true })
    try {
      const outcome = await input.run(target, instructions)
      if (outcome.error) {
        input.onError(outcome.error)
      }
      return outcome.accepted
    } finally {
      publish({ ...snapshot, busy: false })
    }
  }
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    back: () => publish({ page: 'review', choices: root, busy: false }),
    submit: (instructions: string) =>
      !snapshot.busy && instructions.trim()
        ? run({ type: 'custom' }, instructions.trim())
        : Promise.resolve(false),
    async select(value: string): Promise<boolean> {
      if (snapshot.busy) {
        return false
      }
      if (snapshot.page === 'baseBranch') {
        return run({ type: 'baseBranch', branch: value })
      }
      if (snapshot.page === 'commit') {
        return run({
          type: 'commit',
          sha: value,
          title: snapshot.choices.find((choice) => choice.value === value)?.label
        })
      }
      if (value === 'uncommittedChanges') {
        return run({ type: 'uncommittedChanges' })
      }
      if (value === 'custom') {
        publish({ page: 'custom', choices: [], busy: false })
        return false
      }
      if (value !== 'baseBranch' && value !== 'commit') {
        return false
      }
      const loading: ReviewMenuSnapshot = { page: value, choices: [], busy: true }
      publish(loading)
      try {
        const choices =
          value === 'baseBranch'
            ? (await input.branches()).map((branch) => ({ value: branch, label: branch }))
            : (await input.commits()).map((commit) => ({
                value: commit.id,
                label: commit.subject,
                description: commit.id.slice(0, 7)
              }))
        if (snapshot === loading) {
          publish({ page: value, choices, busy: false })
        }
      } catch {
        if (snapshot === loading) {
          input.onError('Codex could not load review targets. Try /review again.')
          publish({ page: 'review', choices: root, busy: false })
        }
      }
      return false
    }
  }
}
