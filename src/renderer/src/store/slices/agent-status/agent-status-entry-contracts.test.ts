import { describe } from 'vitest'
import { registerAgentStatusNestedResumeTests } from './sleep-recovery/agent-status-nested-resume.spec'
import { registerAgentStatusToolAssistantFieldsTests } from './live-status/agent-status-tool-assistant-fields.spec'

describe('agent-status-nested-resume', registerAgentStatusNestedResumeTests)
describe('agent-status-tool-assistant-fields', registerAgentStatusToolAssistantFieldsTests)
