import type { TerminalConversationSelection } from './terminal-conversation-identity'

/** What a model picker remembers about reported models for the conversation it shows. */
export type ConversationModelReportBaseline = {
  /** Agent + full locator of the conversation this baseline belongs to; null until one is known. */
  conversationKey: string | null
  /** The last reported model this picker applied, from either source. */
  model: string | null
  /** The last usable field report the picker observed, applied or not. */
  observedFieldReportKey: string | null
}

export type ConversationModelReport = {
  conversationKey: string | null
  /** The reported model after the picker matched it to its catalog. */
  model: string | null
  modelSource: TerminalConversationSelection['modelSource']
  fieldReportKey: string | null
}

export const EMPTY_CONVERSATION_MODEL_REPORT_BASELINE: ConversationModelReportBaseline = {
  conversationKey: null,
  model: null,
  observedFieldReportKey: null
}

/**
 * Whether a reported model should replace the picker's value. Only new evidence may undo a user's
 * pick: a status model when it differs from the last applied one, a field model when nothing is
 * applied yet or its report identity changed. Switching back to an unchanged field is not a report.
 */
export function decideConversationModelReport(
  previous: ConversationModelReportBaseline | undefined,
  report: ConversationModelReport
): { apply: boolean; baseline: ConversationModelReportBaseline } {
  let baseline = previous ?? EMPTY_CONVERSATION_MODEL_REPORT_BASELINE
  if (report.conversationKey !== null && report.conversationKey !== baseline.conversationKey) {
    // Why adopt without reset from unknown: a report that later gains its address is the same conversation.
    baseline =
      baseline.conversationKey === null
        ? { ...baseline, conversationKey: report.conversationKey }
        : { ...EMPTY_CONVERSATION_MODEL_REPORT_BASELINE, conversationKey: report.conversationKey }
  }
  const previousObserved = baseline.observedFieldReportKey
  // Why: a frame without usable field evidence is no observation, so it never erases the baseline.
  if (report.fieldReportKey !== null && report.fieldReportKey !== previousObserved) {
    baseline = { ...baseline, observedFieldReportKey: report.fieldReportKey }
  }
  const apply =
    report.model !== null &&
    (report.modelSource === 'status'
      ? report.model !== baseline.model
      : report.modelSource === 'field' &&
        report.fieldReportKey !== null &&
        (baseline.model === null || report.fieldReportKey !== previousObserved))
  if (apply) {
    baseline = { ...baseline, model: report.model }
  }
  return { apply, baseline }
}
