import type { ConnectorAccessRequest } from '../connector-bot-access-contract'

export function makeAccessRequest(
  overrides: Partial<ConnectorAccessRequest> = {}
): ConnectorAccessRequest {
  return {
    requestId: 'req-1',
    botId: 'bot-1',
    source: 'slack',
    workspaceId: 'T1',
    workspaceName: 'Acme',
    requester: { id: 'U9', name: 'Dana Kim', handle: 'dana', detail: 'Dana Kim' },
    createdAt: 1,
    expiresAt: 2,
    ...overrides
  }
}
