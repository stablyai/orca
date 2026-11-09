import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAppStore } from '@/store'
import { useOrgRoster } from '../../billing/team/use-org-roster'
import { CloudAgentSetupDialog } from '../../cloud-agent-setup/CloudAgentSetupDialog'
import { cloudSecretRepoChoices } from './cloud-secret-repos'
import { CloudSecretsPane } from './CloudSecretsPane'
import type { CloudSecretsApi } from './use-cloud-secrets'

const NOBODY = (): null => null

function TeamCloudSecretsPane({
  orgId,
  ...props
}: Omit<React.ComponentProps<typeof CloudSecretsPane>, 'people'> & {
  orgId: string
}): React.JSX.Element {
  const roster = useOrgRoster(orgId)
  const members = roster.result?.status === 'ok' ? roster.result.roster.members : null
  const nameFor = useCallback(
    (userId: string) => {
      const member = members?.find((entry) => entry.userId === userId)
      return member ? (member.displayName ?? member.email) : null
    },
    [members]
  )
  return <CloudSecretsPane {...props} people={{ nameFor }} />
}

/** Shown only where Orca Cloud is offered to this account. */
export function CloudSecretsSection({ orgId }: { orgId: string | null }): React.JSX.Element | null {
  const api: CloudSecretsApi | undefined = window.api.cloudSecrets
  const [available, setAvailable] = useState(false)
  const [setupOpen, setSetupOpen] = useState(false)
  const [revision, setRevision] = useState(0)
  const repos = useAppStore((s) => s.repos)
  const choices = useMemo(() => cloudSecretRepoChoices(repos), [repos])

  useEffect(() => {
    if (!api) {
      return
    }
    let cancelled = false
    void api.status().then(
      (status) => !cancelled && setAvailable(status.available),
      () => !cancelled && setAvailable(false)
    )
    return () => {
      cancelled = true
    }
  }, [api])

  if (!api || !available) {
    return null
  }
  const common = {
    api,
    repos: choices,
    onSetUpAgent: () => setSetupOpen(true)
  }
  return (
    <>
      {orgId ? (
        <TeamCloudSecretsPane key={revision} {...common} orgId={orgId} />
      ) : (
        <CloudSecretsPane key={revision} {...common} people={{ nameFor: NOBODY }} />
      )}
      <CloudAgentSetupDialog
        open={setupOpen}
        onOpenChange={setSetupOpen}
        onSaved={() => setRevision((value) => value + 1)}
      />
    </>
  )
}
