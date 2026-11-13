// Builders for the build sheet's Secrets row fixtures (S2), on the Orca Cloud sheet.
import React from 'react'
import type { CloudSecretsCaller } from '../../../../shared/cloud-secrets/cloud-secrets-wire'
import type { CloudSecretsAskData } from '../cloud-secrets-ask/cloud-secrets-ask-model'
import {
  EMPTY_ASK_STATE,
  type CloudSecretsAskFormActions,
  type CloudSecretsAskFormState
} from '../cloud-secrets-ask/CloudSecretsAskForm'
import { VmBuildSecretsRowView } from '../cloud-secrets-ask/VmBuildSecretsRow'

const ADMIN: CloudSecretsCaller = {
  userId: 'u_ada',
  orgId: 'org_acme',
  orgRole: 'admin',
  canWrite: { personal: true, org: true, repo: true }
}
const MEMBER: CloudSecretsCaller = {
  userId: 'u_bo',
  orgId: 'org_acme',
  orgRole: 'member',
  canWrite: { personal: true, org: false, repo: false }
}

export function secretsData(
  role: 'admin' | 'member',
  patch: Partial<CloudSecretsAskData> = {}
): CloudSecretsAskData {
  return {
    environmentName: 'acme-web',
    total: 5,
    missing: ['STRIPE_TEST_KEY', 'SENTRY_DSN'],
    caller: role === 'admin' ? ADMIN : MEMBER,
    built: false,
    repoKey: 'github.com/acme/web',
    shared: false,
    ...patch
  }
}

const noop = (): void => {}
const ACTIONS: CloudSecretsAskFormActions = {
  onValueChange: noop,
  onScopeChange: noop,
  onTogglePaste: noop,
  onPaste: noop,
  onSave: noop,
  onSkip: noop
}

export function secretsRow(
  data: CloudSecretsAskData,
  state: Partial<CloudSecretsAskFormState> = {}
): React.ReactNode {
  return (
    <VmBuildSecretsRowView data={data} state={{ ...EMPTY_ASK_STATE, ...state }} actions={ACTIONS} />
  )
}
