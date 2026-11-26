/** `approved` also answers a denial already approved; `unavailable`: the agent is not running to record it. */
export type AgentSessionAutoReviewApprovalResult =
  | { status: 'approved' }
  | { status: 'unavailable' }
  | { status: 'unsupported' }
  | { status: 'refused' }

/** The row that shows, as the person's own act, their approval of one denied action. */
export const AUTO_REVIEW_APPROVAL_PRESENTATION = 'auto-review-approval'
