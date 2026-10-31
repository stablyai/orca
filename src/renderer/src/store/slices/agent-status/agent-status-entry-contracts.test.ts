import { describe } from 'vitest'
import { registerAgentStatusNestedResumeTests } from './agent-status-nested-resume.spec'
import { registerAgentStatusToolAssistantFieldsTests } from './agent-status-tool-assistant-fields.spec'
import { registerAgentStatusPrRefreshHandoffTests } from './agent-status-pr-refresh-handoff.spec'

describe('agent-status-nested-resume', registerAgentStatusNestedResumeTests)
describe('agent-status-tool-assistant-fields', registerAgentStatusToolAssistantFieldsTests)
describe('agent-status-pr-refresh-handoff', registerAgentStatusPrRefreshHandoffTests)
