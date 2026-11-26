import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { getAgentCatalog } from '@/lib/agent-catalog/agent-catalog'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import type { AgentSessionModelCatalogResult } from '../../../../shared/agent-session/agent-session-wire'
import type { PipelineV2Stage } from '../../../../shared/pipelines/v2/pipeline-v2-contracts'
import { PipelineSelectField, PipelineTextField } from './PipelineFormFields'
import { isTuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent-config'
import { pipelineV2PermissionChoices } from '../../../../shared/pipelines/v2/pipeline-v2-permissions'
import { agentPermissionChoiceLabel } from '../agent/launch-settings/agent-permission-choice-label'

type Executor = Extract<PipelineV2Stage, { kind: 'agent' }>['executor']
export function PipelineExecutorEditor({
  executor,
  workspacePath,
  onChange
}: {
  executor: Executor
  workspacePath?: string
  onChange: (executor: Executor) => void
}) {
  const t = useTranslate()
  const [catalog, setCatalog] = useState<AgentSessionModelCatalogResult>()
  const [error, setError] = useState('')
  const [refresh, setRefresh] = useState(0)
  useEffect(() => {
    let cancelled = false
    setCatalog(undefined)
    setError('')
    void callRuntimeRpc<AgentSessionModelCatalogResult>(
      { kind: 'local' },
      'agentSession.modelCatalog',
      {
        agent: executor.agent,
        ...(workspacePath ? { worktree: workspacePath } : {}),
        waitForListing: true
      }
    )
      .then((value) => {
        if (!cancelled) {
          setCatalog(value)
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setError(String(error))
        }
      })
    return () => {
      cancelled = true
    }
  }, [executor.agent, workspacePath, refresh])
  const models = catalog?.origin && catalog.origin !== 'unknown' ? catalog.models : []
  const explicitModel = executor.model.kind === 'explicit' ? executor.model.id : undefined
  const selected = explicitModel
    ? models.find((model) => model.id === explicitModel)
    : models.find((model) => model.isDefault)
  const efforts =
    executor.surface === 'chat' ? (selected?.chatEfforts ?? selected?.efforts) : selected?.efforts
  return (
    <div className="grid gap-3 @lg:grid-cols-2">
      <PipelineSelectField
        label={t('pipelines.agent', 'Agent')}
        value={executor.agent}
        options={getAgentCatalog().map((agent) => ({ value: agent.id, label: agent.label }))}
        onChange={(agent) =>
          onChange({
            agent,
            model: { kind: 'default' },
            surface: executor.surface,
            session: { kind: 'fresh' },
            permissionMode: 'own'
          })
        }
      />
      <PipelineSelectField
        label={t('pipelines.surface', 'Surface')}
        value={executor.surface}
        options={[
          { value: 'chat', label: t('pipelines.chat', 'Chat') },
          { value: 'terminal', label: t('pipelines.terminal', 'Terminal') }
        ]}
        onChange={(surface) => {
          if (surface === 'chat' || surface === 'terminal') {
            onChange({ ...executor, surface, effort: undefined })
          }
        }}
      />
      <PipelineSelectField
        label={t('pipelines.model', 'Model')}
        value={executor.model.kind === 'explicit' ? executor.model.id : '__default'}
        options={[
          {
            value: '__default',
            label: t('pipelines.default', 'Agent default')
          },
          ...models.map((model) => ({ value: model.id, label: model.label }))
        ]}
        onChange={(id) =>
          onChange({
            ...executor,
            model: id === '__default' ? { kind: 'default' } : { kind: 'explicit', id },
            effort: undefined
          })
        }
      />
      <PipelineSelectField
        label={t('pipelines.effort', 'Effort')}
        value={executor.effort ?? '__default'}
        options={[
          {
            value: '__default',
            label: t('pipelines.default', 'Agent default')
          },
          ...(efforts ?? []).map((effort) => ({ value: effort.value, label: effort.label }))
        ]}
        onChange={(effort) =>
          onChange({ ...executor, effort: effort === '__default' ? undefined : effort })
        }
      />
      <PipelineSelectField
        label={t('pipelines.sessionPolicy', 'Session')}
        value={executor.session.kind}
        options={[
          { value: 'fresh', label: t('pipelines.fresh', 'New session') },
          { value: 'reuse', label: t('pipelines.reuse', 'Reuse session group') }
        ]}
        onChange={(kind) =>
          onChange({
            ...executor,
            session: kind === 'fresh' ? { kind } : { kind: 'reuse', groupId: 'primary' }
          })
        }
      />
      {executor.session.kind === 'reuse' && (
        <PipelineTextField
          label={t('pipelines.sessionGroup', 'Session group')}
          value={executor.session.groupId}
          maxLength={128}
          onChange={(groupId) => onChange({ ...executor, session: { kind: 'reuse', groupId } })}
        />
      )}
      <PipelineSelectField
        label={t('pipelines.permission', 'Permissions')}
        value={executor.permissionMode ?? 'own'}
        options={
          isTuiAgent(executor.agent)
            ? pipelineV2PermissionChoices(
                executor.agent,
                executor.surface,
                selected?.supportsAutoMode
              ).map((choice) => ({
                value: choice,
                label: agentPermissionChoiceLabel(choice, null, t)
              }))
            : [{ value: 'own', label: t('pipelines.ownPermissions', 'Agent settings') }]
        }
        onChange={(permissionMode) => onChange({ ...executor, permissionMode })}
      />
      <p className="text-xs text-muted-foreground @lg:col-span-2">
        {error ||
          (catalog?.unavailable
            ? t(
                'pipelines.modelUnavailable',
                'The agent is currently unavailable. Resolve its account or runtime state before launching.'
              )
            : models.length
              ? t(
                  'pipelines.modelVerifiedAtLaunch',
                  'Available models are read from Orca. The exact model, effort and session compatibility are checked again before creation.'
                )
              : t(
                  'pipelines.modelLoading',
                  'Model availability is not yet verified. Creation will require a verified catalog.'
                ))}
      </p>
      <Button
        variant="link"
        size="sm"
        className="justify-self-start @lg:col-span-2"
        onClick={() => setRefresh((value) => value + 1)}
      >
        {t('pipelines.reloadModels', 'Reload available models')}
      </Button>
    </div>
  )
}
