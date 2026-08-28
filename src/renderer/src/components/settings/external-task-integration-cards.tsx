import { ClipboardList, Cloud, ExternalLink, Ticket } from 'lucide-react'
import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { IntegrationCardDetails, IntegrationCardShell } from './integration-card-shell'
import type { ExternalTaskProvider } from '../../../../shared/external-task-types'

type ExternalTaskIntegrationCardProps = {
  name: string
  icon: React.JSX.Element
  description: string
  setup: string
  docsUrl: string
  provider: ExternalTaskProvider
  settingsSectionId: string
}

function ExternalTaskIntegrationCard({
  name,
  icon,
  description,
  setup,
  docsUrl,
  provider,
  settingsSectionId
}: ExternalTaskIntegrationCardProps): React.JSX.Element {
  const [checking, setChecking] = useState(true)
  const [configured, setConfigured] = useState(false)
  useEffect(() => {
    void window.api.externalTasks.status(provider).then((status) => {
      setConfigured(status.authenticated)
      setChecking(false)
    })
  }, [provider])
  return (
    <IntegrationCardShell
      settingsSectionId={settingsSectionId}
      icon={icon}
      name={name}
      description={description}
      checking={checking}
      statusTone={configured ? 'connected' : 'attention'}
      statusLabel={configured ? 'Configured' : 'Not configured'}
    >
      <IntegrationCardDetails>
        <p className="text-xs text-muted-foreground">{setup}</p>
        <Button variant="outline" size="sm" onClick={() => void window.api.shell.openUrl(docsUrl)}>
          <ExternalLink className="mr-1.5 size-3.5" />
          Setup documentation
        </Button>
      </IntegrationCardDetails>
    </IntegrationCardShell>
  )
}

export function AzureDevOpsWorkItemsIntegrationCard(): React.JSX.Element {
  return (
    <ExternalTaskIntegrationCard
      settingsSectionId="integrations-azure-devops-work-items"
      icon={<Cloud className="size-5" />}
      name="Azure DevOps work items"
      description="Browse work items and start Orca workspaces from them."
      setup="Set ORCA_AZURE_DEVOPS_PAT (the PAT from Azure DevOps) and ORCA_AZURE_DEVOPS_ORGANIZATION (for example, EE-KPEX) in the runtime that owns the repository."
      docsUrl="https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/work-items"
      provider="azure-devops"
    />
  )
}

export function PlannerIntegrationCard(): React.JSX.Element {
  return (
    <ExternalTaskIntegrationCard
      settingsSectionId="integrations-planner"
      icon={<ClipboardList className="size-5" />}
      name="Microsoft Planner"
      description="Browse your Planner tasks and start linked Orca workspaces."
      setup="Connect Microsoft Graph with a delegated access token. Store the token as ORCA_PLANNER_ACCESS_TOKEN in the runtime that should read Planner."
      docsUrl="https://learn.microsoft.com/en-us/graph/api/resources/planner-overview"
      provider="planner"
    />
  )
}

export function NinjaOneIntegrationCard(): React.JSX.Element {
  return (
    <ExternalTaskIntegrationCard
      settingsSectionId="integrations-ninjaone"
      icon={<Ticket className="size-5" />}
      name="NinjaOne ticketing"
      description="Browse NinjaOne tickets and start linked Orca workspaces."
      setup="Set ORCA_NINJAONE_CLIENT_ID, ORCA_NINJAONE_CLIENT_SECRET, and ORCA_NINJAONE_INSTANCE_URL in the runtime that owns the integration."
      docsUrl="https://www.ninjaone.com/docs/api/"
      provider="ninjaone"
    />
  )
}
