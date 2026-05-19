import type { ElectronApplication } from '@stablyai/playwright-test'
import { existsSync, readdirSync, readFileSync } from 'fs'
import path from 'path'
import {
  isAgentHookEndpointFileName,
  parseAgentHookEndpointFile,
  type AgentHookEndpoint
} from '../../../src/shared/agent-hook-endpoint-file'

function findEndpointEnvFile(root: string): string | null {
  if (!existsSync(root)) {
    return null
  }
  const entries = readdirSync(root, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name)
    if (entry.isFile() && isAgentHookEndpointFileName(entry.name)) {
      return fullPath
    }
    if (entry.isDirectory()) {
      const nested = findEndpointEnvFile(fullPath)
      if (nested) {
        return nested
      }
    }
  }
  return null
}

export async function readHookEndpoint(app: ElectronApplication): Promise<AgentHookEndpoint> {
  const userDataPath = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'))
  const hookRoot = path.join(userDataPath, 'agent-hooks')
  const endpointPath = findEndpointEnvFile(hookRoot)
  if (!endpointPath) {
    throw new Error(`Agent hook endpoint file not found under ${hookRoot}`)
  }
  return parseAgentHookEndpointFile(readFileSync(endpointPath, 'utf8'))
}

export async function emitCodexHookStatus(
  endpoint: AgentHookEndpoint,
  status: {
    paneKey: string
    worktreeId: string
    state: 'working' | 'done'
    prompt?: string
    lastAssistantMessage?: string
  }
): Promise<void> {
  const [tabId] = status.paneKey.split(':')
  const payload =
    status.state === 'working'
      ? {
          hook_event_name: 'UserPromptSubmit',
          prompt: status.prompt
        }
      : {
          hook_event_name: 'Stop',
          last_assistant_message: status.lastAssistantMessage
        }
  const response = await fetch(`http://127.0.0.1:${endpoint.port}/hook/codex`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Orca-Agent-Hook-Token': endpoint.token
    },
    body: JSON.stringify({
      paneKey: status.paneKey,
      tabId,
      worktreeId: status.worktreeId,
      env: endpoint.env,
      version: endpoint.version,
      payload
    })
  })
  if (response.status !== 204) {
    throw new Error(`Codex hook POST returned ${response.status}`)
  }
}
