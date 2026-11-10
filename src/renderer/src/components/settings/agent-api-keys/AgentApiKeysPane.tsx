import { useMemo, useState } from 'react'
import {
  ChevronDown,
  Download,
  KeyRound,
  Pencil,
  Plus,
  ShieldAlert,
  ShieldCheck,
  Trash2
} from 'lucide-react'
import type { TuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent'
import {
  FEATURED_API_KEY_AGENTS,
  isAgentApiKeyAgent,
  type AgentApiKeySummary
} from '../../../../../shared/agent-api-keys/agent-api-key-catalog'
import {
  agentApiKeyCloudEligible,
  agentApiKeyCloudRowState,
  agentApiKeyRemoveAsksAboutAccount,
  type AgentApiKeysCloudState
} from '../../../../../shared/agent-api-keys/agent-api-key-cloud'
import type { CloudSecretsErrorCode } from '../../../../../shared/cloud-secrets/cloud-secrets-wire'
import { AgentIcon } from '@/components/agent/icons/AgentIcon'
import { getAgentCatalog, getAgentLabel } from '@/lib/agent-catalog/agent-catalog'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { Button } from '../../ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '../../ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '../../ui/tooltip'
import { SettingsGroup } from '../section-layout/SettingsGroup'
import { AgentApiKeyEditor, type AgentApiKeyHostChoice } from './AgentApiKeyEditor'
import type { AgentApiKeysModel } from './use-agent-api-keys'
import {
  AgentApiKeyCloudLine,
  AgentApiKeyRemoveFromAccountConfirm,
  AgentApiKeysNotice,
  type AgentApiKeysNoticeState
} from './AgentApiKeyCloudLine'
import { AgentApiKeysImportPanel, useAgentApiKeysImport } from './AgentApiKeysImportPanel'
import type { ImportScanState } from './agent-api-keys-import'

type Editing = { agent: TuiAgent; keyId: string | null } | null

function scopeLabel(
  key: AgentApiKeySummary,
  hosts: readonly AgentApiKeyHostChoice[],
  t: Translate
): string {
  if (key.hostScope.kind === 'all') {
    return t('auto.components.settings.agentApiKeys.scope.all', 'Every host')
  }
  const labels = hosts
    .filter((host) => key.hostScope.kind === 'hosts' && key.hostScope.hostIds.includes(host.id))
    .map((host) => host.label)
  return labels.length > 0
    ? labels.join(', ')
    : t('auto.components.settings.agentApiKeys.scope.gone', 'A host that is no longer listed')
}

function KeyLine({
  apiKey,
  hosts,
  canEdit,
  cloud,
  cloudFailure,
  onEdit,
  onRemove,
  onSaveToAccount
}: {
  apiKey: AgentApiKeySummary
  hosts: readonly AgentApiKeyHostChoice[]
  canEdit: boolean
  cloud: AgentApiKeysCloudState | undefined
  cloudFailure: CloudSecretsErrorCode | undefined
  onEdit: () => void
  onRemove: (fromAccount: boolean) => Promise<void>
  onSaveToAccount: () => Promise<CloudSecretsErrorCode | null>
}): React.JSX.Element {
  const t = useTranslate()
  const [confirming, setConfirming] = useState(false)
  const asksAboutAccount = agentApiKeyRemoveAsksAboutAccount(apiKey, cloud)
  return (
    <li className="group space-y-1 rounded-md px-2 py-1.5 hover:bg-accent/40">
      <div className="flex items-center gap-3">
        <KeyRound className="size-3.5 shrink-0 text-muted-foreground" />
        <code className="w-52 shrink-0 truncate font-mono text-xs">{apiKey.envName}</code>
        <span className="w-16 shrink-0 font-mono text-xs text-muted-foreground">
          ••••{apiKey.hint}
        </span>
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {scopeLabel(apiKey, hosts, t)}
        </span>
        <div className="flex shrink-0 items-center gap-0.5">
          {confirming && asksAboutAccount ? null : confirming ? (
            <>
              <Button variant="ghost" size="xs" onClick={() => setConfirming(false)}>
                {t('auto.components.settings.agentApiKeys.keep', 'Keep')}
              </Button>
              <Button variant="destructive-chip" size="xs" onClick={() => void onRemove(false)}>
                {t('auto.components.settings.agentApiKeys.confirmRemove', 'Remove key')}
              </Button>
            </>
          ) : (
            <>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    disabled={!canEdit}
                    onClick={onEdit}
                    aria-label={t('auto.components.settings.agentApiKeys.edit', 'Edit key')}
                  >
                    <Pencil />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  {t('auto.components.settings.agentApiKeys.edit', 'Edit key')}
                </TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={() => setConfirming(true)}
                    aria-label={t('auto.components.settings.agentApiKeys.remove', 'Remove key')}
                  >
                    <Trash2 />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  {t('auto.components.settings.agentApiKeys.remove', 'Remove key')}
                </TooltipContent>
              </Tooltip>
            </>
          )}
        </div>
      </div>
      {confirming && asksAboutAccount ? (
        <AgentApiKeyRemoveFromAccountConfirm
          envName={apiKey.envName}
          onCancel={() => setConfirming(false)}
          onRemove={(fromAccount) => void onRemove(fromAccount)}
        />
      ) : (
        <AgentApiKeyCloudLine
          envName={apiKey.envName}
          state={agentApiKeyCloudRowState(apiKey, cloud)}
          canSave={agentApiKeyCloudEligible(apiKey)}
          failure={cloudFailure}
          onSaveToAccount={onSaveToAccount}
        />
      )}
    </li>
  )
}

export function AgentApiKeysPane({
  model,
  hosts,
  initiallyEditing = null,
  initialImport = null
}: {
  model: AgentApiKeysModel
  hosts: readonly AgentApiKeyHostChoice[]
  /** Lets the in-pane sign-in card open straight into "add a key for this agent". */
  initiallyEditing?: Editing
  /** Fixtures: open "Import from this Mac" in a given state. */
  initialImport?: ImportScanState | null
}): React.JSX.Element {
  const t = useTranslate()
  const [editing, setEditing] = useState<Editing>(initiallyEditing)
  const [notice, setNotice] = useState<AgentApiKeysNoticeState>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const cloud = model.state?.cloud
  const signedIn = cloud?.signedIn === true
  const importer = useAgentApiKeysImport(model, initialImport, (outcome) => {
    setFailure(outcome.failure)
    setNotice(outcome.imported > 0 ? { kind: 'imported', count: outcome.imported } : null)
  })
  const removeKey = async (apiKey: AgentApiKeySummary, fromAccount: boolean): Promise<void> => {
    const asked = agentApiKeyRemoveAsksAboutAccount(apiKey, cloud)
    setNotice(null)
    const error = await model.remove(apiKey.id, fromAccount)
    setFailure(error)
    if (!error && asked && !fromAccount) {
      setNotice({ kind: 'kept' })
    }
  }
  const [extraAgents, setExtraAgents] = useState<TuiAgent[]>(
    initiallyEditing ? [initiallyEditing.agent] : []
  )
  const keys = useMemo(() => model.state?.keys ?? [], [model.state])
  const protection = model.state?.protection
  const canEdit = protection?.available === true

  const agents = useMemo(() => {
    const listed: TuiAgent[] = [...FEATURED_API_KEY_AGENTS]
    for (const agent of [...keys.map((key) => key.agent), ...extraAgents]) {
      if (!listed.includes(agent)) {
        listed.push(agent)
      }
    }
    return listed
  }, [keys, extraAgents])
  const otherAgents = useMemo(
    () =>
      getAgentCatalog()
        .map((entry) => entry.id)
        .filter((agent) => isAgentApiKeyAgent(agent) && !agents.includes(agent)),
    [agents]
  )

  return (
    <div className="space-y-4">
      {protection?.available === true ? (
        <div className="flex items-start gap-2.5 text-xs leading-5 text-muted-foreground">
          <ShieldCheck className="mt-0.5 size-4 shrink-0" />
          <p>
            {t(
              'agentApiKeys.promiseAccount',
              'Keys are sealed on this computer. When you’re signed in to Orca, they’re also saved in your Orca account for cloud workspaces. On SSH hosts and paired machines, Orca passes a key for that run only and never writes it there.'
            )}
          </p>
        </div>
      ) : protection ? (
        <div className="flex items-start gap-2.5 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2.5 text-xs leading-5">
          <ShieldAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
          <div>
            <p className="font-medium text-foreground">
              {t(
                'auto.components.settings.agentApiKeys.unavailableTitle',
                "Orca won't store API keys on this computer"
              )}
            </p>
            <p className="text-muted-foreground">{protection.reason}</p>
          </div>
        </div>
      ) : null}

      <AgentApiKeysNotice failure={failure} notice={notice} />

      <SettingsGroup bodyClassName="px-0">
        {agents.map((agent) => {
          const agentKeys = keys.filter((key) => key.agent === agent)
          const addingHere = editing?.agent === agent && editing.keyId === null
          return (
            <div key={agent} data-settings-row="" className="px-5 py-3">
              <div className="flex items-center gap-3">
                <AgentIcon agent={agent} size={18} />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{getAgentLabel(agent)}</p>
                  {agentKeys.length === 0 ? (
                    <p className="text-xs text-muted-foreground">
                      {t(
                        'auto.components.settings.agentApiKeys.noKey',
                        'No key. The agent uses its own sign-in.'
                      )}
                    </p>
                  ) : null}
                </div>
                {!addingHere ? (
                  <Button
                    variant="outline"
                    size="xs"
                    disabled={!canEdit}
                    onClick={() => setEditing({ agent, keyId: null })}
                  >
                    <Plus />
                    {t('auto.components.settings.agentApiKeys.addKey', 'Add key')}
                  </Button>
                ) : null}
              </div>
              {agentKeys.length > 0 ? (
                <ul className="mt-2 -mx-2 space-y-0.5 pl-[30px]">
                  {agentKeys.map((apiKey) =>
                    editing?.keyId === apiKey.id ? (
                      <li key={apiKey.id} className="px-2 py-1">
                        <AgentApiKeyEditor
                          agent={agent}
                          initial={apiKey}
                          hosts={hosts}
                          onSave={async (request) => {
                            const failure = await model.save(request)
                            if (!failure) {
                              setEditing(null)
                            }
                            return failure
                          }}
                          onCancel={() => setEditing(null)}
                        />
                      </li>
                    ) : (
                      <KeyLine
                        key={apiKey.id}
                        apiKey={apiKey}
                        hosts={hosts}
                        canEdit={canEdit}
                        cloud={cloud}
                        cloudFailure={model.cloudFailures?.[apiKey.id]}
                        onEdit={() => setEditing({ agent, keyId: apiKey.id })}
                        onRemove={(fromAccount) => removeKey(apiKey, fromAccount)}
                        onSaveToAccount={() =>
                          model.saveToAccount?.(apiKey.id) ?? Promise.resolve('not_configured')
                        }
                      />
                    )
                  )}
                </ul>
              ) : null}
              {addingHere ? (
                <div className="mt-3 pl-[30px]">
                  <AgentApiKeyEditor
                    agent={agent}
                    hosts={hosts}
                    onSave={async (request) => {
                      const failure = await model.save(request)
                      if (!failure) {
                        setEditing(null)
                      }
                      return failure
                    }}
                    onCancel={() => setEditing(null)}
                  />
                </div>
              ) : null}
            </div>
          )
        })}
      </SettingsGroup>

      {importer.scan ? (
        <AgentApiKeysImportPanel
          scan={importer.scan}
          signedIn={signedIn}
          onRetry={importer.start}
          onClose={importer.close}
          onImport={importer.run}
        />
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        {model.scanThisComputer && !importer.scan ? (
          <Button variant="outline" size="sm" disabled={!canEdit} onClick={importer.start}>
            <Download />
            {t('agentApiKeys.import.openComputer', 'Import from this computer')}
          </Button>
        ) : null}
        {otherAgents.length > 0 ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild disabled={!canEdit}>
              <Button variant="outline" size="sm">
                <Plus />
                {t(
                  'auto.components.settings.agentApiKeys.anotherAgent',
                  'Add a key for another agent'
                )}
                <ChevronDown className="text-muted-foreground" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="max-h-72">
              {otherAgents.map((agent) => (
                <DropdownMenuItem
                  key={agent}
                  onSelect={() => {
                    setExtraAgents((current) => [...current, agent])
                    setEditing({ agent, keyId: null })
                  }}
                >
                  <AgentIcon agent={agent} size={14} />
                  {getAgentLabel(agent)}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
    </div>
  )
}
