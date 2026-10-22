import { AGENT_STATUS_INTERACTIVE_PROMPT_MAX_LENGTH } from './agent-status-types'

// Why: OMP's plan review overlay holds the keyboard, so Orca's extension reads this
// OSC before the overlay does and answers through ctx.resolvePlanReview.
export const OMP_PLAN_REVIEW_ANSWER_PREFIX = '\x1b]7503;orca-plan-review;'

/** OMP's own choice ids; `refine` needs feedback, so the card dismisses the overlay instead. */
const OMP_PLAN_REVIEW_CHOICES: ReadonlySet<string> = new Set(['execute', 'compact', 'keep', 'save'])
export const OMP_PLAN_REVIEW_DISMISS = 'dismiss'
const TRUNCATION_NOTE = '\n\n…'

type OmpPlanReviewOption = { id: string; label: string }

export type OmpPlanReviewPrompt = {
  reviewId: string
  plan: string
  options: { label: string; send: string }[]
}

export function buildOmpPlanReviewAnswer(reviewId: string, choice: string): string {
  return `${OMP_PLAN_REVIEW_ANSWER_PREFIX}${reviewId};${choice}\x07`
}

function readPlanReviewOptions(value: unknown): OmpPlanReviewOption[] {
  return (Array.isArray(value) ? value : []).flatMap((option: unknown) =>
    option &&
    typeof option === 'object' &&
    'id' in option &&
    'label' in option &&
    typeof option.id === 'string' &&
    typeof option.label === 'string' &&
    option.label.length > 0
      ? [{ id: option.id, label: option.label }]
      : []
  )
}

/** The `interactivePrompt` envelope for an open OMP plan review, clipped to the field's cap. */
export function serializeOmpPlanReviewPrompt(
  reviewId: string,
  plan: string,
  rawOptions: unknown
): string {
  const options = readPlanReviewOptions(rawOptions)
  const serialize = (text: string): string =>
    JSON.stringify({ planReview: { reviewId, plan: text, options } })
  let text = plan
  let json = serialize(text)
  while (json.length > AGENT_STATUS_INTERACTIVE_PROMPT_MAX_LENGTH && text.length > 0) {
    const excess = json.length - AGENT_STATUS_INTERACTIVE_PROMPT_MAX_LENGTH
    text = text.slice(0, Math.max(0, text.length - excess - TRUNCATION_NOTE.length))
    json = serialize(`${text}${TRUNCATION_NOTE}`)
  }
  return json
}

export function parseOmpPlanReviewPrompt(
  interactivePrompt: string | undefined | null
): OmpPlanReviewPrompt | null {
  if (!interactivePrompt) {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(interactivePrompt)
  } catch {
    return null
  }
  const review =
    parsed && typeof parsed === 'object' && 'planReview' in parsed ? parsed.planReview : null
  if (
    !review ||
    typeof review !== 'object' ||
    !('reviewId' in review) ||
    !('plan' in review) ||
    typeof review.reviewId !== 'string' ||
    !/^[\w-]+$/.test(review.reviewId) ||
    typeof review.plan !== 'string'
  ) {
    return null
  }
  const reviewId = review.reviewId
  const plan = review.plan
  const options = 'options' in review ? review.options : undefined
  const cardOptions = readPlanReviewOptions(options).flatMap(({ id, label }) => {
    const choice = id === 'refine' ? OMP_PLAN_REVIEW_DISMISS : id
    return choice === OMP_PLAN_REVIEW_DISMISS || OMP_PLAN_REVIEW_CHOICES.has(choice)
      ? [{ label, send: buildOmpPlanReviewAnswer(reviewId, choice) }]
      : []
  })
  return cardOptions.length > 0 ? { reviewId, plan, options: cardOptions } : null
}
