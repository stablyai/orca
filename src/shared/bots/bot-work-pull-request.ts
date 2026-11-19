import type {
  CheckStatus,
  PRReviewDecision,
  PRState
} from '../github/pull-requests/pull-request-types'

/** The pull request of a bot worker's branch, as the GitHub client read it. */
export type BotWorkPullRequest = {
  number: number
  url: string
  state: PRState
  checks: CheckStatus
  review: PRReviewDecision | null
  /** The PR's head commit, when GitHub named it. */
  headSha: string | null
}
