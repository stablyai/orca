import type { DirectWorkItemSetupRequest } from './direct-work-item-setup'

function isSetupRequest(value: unknown): value is DirectWorkItemSetupRequest {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    typeof value.id === 'number' &&
    'repoName' in value &&
    typeof value.repoName === 'string' &&
    'inspection' in value &&
    typeof value.inspection === 'object' &&
    value.inspection !== null &&
    'kind' in value.inspection &&
    ['unavailable', 'needs-modal'].includes(String(value.inspection.kind)) &&
    'inspect' in value &&
    typeof value.inspect === 'function' &&
    'choose' in value &&
    typeof value.choose === 'function' &&
    'cancel' in value &&
    typeof value.cancel === 'function' &&
    'isPending' in value &&
    typeof value.isPending === 'function'
  )
}

export function readDirectSetupRequest(request: unknown): DirectWorkItemSetupRequest {
  if (!isSetupRequest(request)) {
    throw new Error('Expected the production setup request in the modal slot')
  }
  return request
}
