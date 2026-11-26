import { createNonSecureContextUuid } from '../identifiers/non-secure-context-uuid'
export {
  HANDOFF_GOAL_LIMIT,
  HANDOFF_SECTION_LIMIT,
  type HandoffFields,
  encodeHandoffBody,
  handoffPrompt,
  isHandoffPage,
  readHandoff
} from './handoff-content'

export function createHandoffPageId(): string {
  return `handoff-${createNonSecureContextUuid()}`
}
