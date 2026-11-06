import { translate } from '@/i18n/i18n'
import {
  TEXT_GENERATION_SETTLEMENT_FAILURE_COPY as EN,
  type TextGenerationSettlementFailureCode
} from '../../../shared/text-generation-failure-copy'

type CopyValues = Record<string, string | number>

export const TEXT_GENERATION_SETTLEMENT_ERROR_COPY: Record<
  TextGenerationSettlementFailureCode,
  (values: CopyValues) => string
> = {
  generationCanceled: (values) =>
    translate(
      'sourceControl.textGeneration.errors.generationCanceled',
      EN.generationCanceled,
      values
    ),
  generationAttemptBudgetEnded: (values) =>
    translate(
      'sourceControl.textGeneration.errors.generationAttemptBudgetEnded',
      EN.generationAttemptBudgetEnded,
      values
    ),
  generationRequestChanged: (values) =>
    translate(
      'sourceControl.textGeneration.errors.generationRequestChanged',
      EN.generationRequestChanged,
      values
    ),
  generationAccountChanged: (values) =>
    translate(
      'sourceControl.textGeneration.errors.generationAccountChanged',
      EN.generationAccountChanged,
      values
    ),
  subscriptionAccountsExhausted: (values) =>
    translate(
      'sourceControl.textGeneration.errors.subscriptionAccountsExhausted',
      EN.subscriptionAccountsExhausted,
      values
    ),
  subscriptionAttemptLimit: (values) =>
    translate(
      'sourceControl.textGeneration.errors.subscriptionAttemptLimit',
      EN.subscriptionAttemptLimit,
      values
    ),
  subscriptionNoEligibleAlternate: (values) =>
    translate(
      'sourceControl.textGeneration.errors.subscriptionNoEligibleAlternate',
      EN.subscriptionNoEligibleAlternate,
      values
    ),
  subscriptionBudgetEnded: (values) =>
    translate(
      'sourceControl.textGeneration.errors.subscriptionBudgetEnded',
      EN.subscriptionBudgetEnded,
      values
    )
}
