import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import type { Project, ProjectUpdateArgs } from '../../../../shared/project-types'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { parseExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import { isTuiAgent } from '../../../../shared/tui-agent-config'
import { getAgentCatalog, getAgentLabel } from '@/lib/agent-catalog'
import { translate } from '@/i18n/i18n'
import { Label } from '../ui/label'
import { Button } from '../ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { readHostAgentLaunchSettings } from './agent-launch-settings-transport'

type ProjectDefaultAgentSettingProps = {
  project: Project
  globalDefault: GlobalSettings['defaultTuiAgent'] | undefined
  executionHostId?: ExecutionHostId
  updateProject: (projectId: string, updates: ProjectUpdateArgs['updates']) => unknown
}

export function ProjectDefaultAgentSetting({
  project,
  globalDefault,
  executionHostId,
  updateProject
}: ProjectDefaultAgentSettingProps): React.JSX.Element {
  const [saving, setSaving] = useState(false)
  const [failure, setFailure] = useState<{
    projectId: string
    value: string
    message: string
  } | null>(null)
  const error = failure?.projectId === project.id ? failure : null
  const [remoteGlobal, setRemoteGlobal] = useState<
    | { status: 'loading' | 'unavailable' }
    | { status: 'ready'; value: GlobalSettings['defaultTuiAgent'] }
  >({ status: 'loading' })
  const host = parseExecutionHostId(executionHostId)
  const environmentId = host?.kind === 'runtime' ? host.environmentId : null
  useEffect(() => {
    if (!environmentId) {
      return
    }
    const controller = new AbortController()
    setRemoteGlobal({ status: 'loading' })
    void readHostAgentLaunchSettings({ environmentId }, controller.signal).then(
      (result) => {
        if (!controller.signal.aborted) {
          setRemoteGlobal(
            result ? { status: 'ready', value: result.defaultTuiAgent } : { status: 'unavailable' }
          )
        }
      },
      () => {
        if (!controller.signal.aborted) {
          setRemoteGlobal({ status: 'unavailable' })
        }
      }
    )
    return () => controller.abort()
  }, [environmentId])
  const label = translate('settings.projectDefaultAgent.title', 'Default agent')
  const saved = project.defaultTuiAgent ?? 'inherit'
  const effectiveGlobal = environmentId
    ? remoteGlobal.status === 'ready'
      ? remoteGlobal.value
      : undefined
    : globalDefault
  const globalLabel =
    environmentId && remoteGlobal.status === 'loading'
      ? translate(
          'settings.projectDefaultAgent.targetGlobalLoading',
          'Loading target host global default…'
        )
      : effectiveGlobal === undefined
        ? translate(
            'settings.projectDefaultAgent.targetGlobalUnavailable',
            'Target host global setting unavailable'
          )
        : effectiveGlobal === 'blank'
          ? translate('settings.projectDefaultAgent.blankTerminal', 'Blank Terminal')
          : effectiveGlobal
            ? getAgentLabel(effectiveGlobal)
            : translate('settings.projectDefaultAgent.auto', 'Automatic selection')

  const save = async (value: string): Promise<void> => {
    const next = value === 'inherit' ? null : value === 'blank' || isTuiAgent(value) ? value : null
    if (value !== 'inherit' && next === null) {
      return
    }
    setSaving(true)
    setFailure(null)
    try {
      const result = await updateProject(project.id, { defaultTuiAgent: next })
      if (result !== true) {
        throw new Error(
          translate(
            'settings.projectDefaultAgent.saveFailed',
            'Project default agent could not be saved. Update the target host and try again.'
          )
        )
      }
      toast.success(translate('settings.projectDefaultAgent.saved', 'Project default agent saved'))
    } catch (caught) {
      setFailure({
        projectId: project.id,
        value,
        message: caught instanceof Error ? caught.message : String(caught)
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-2">
      <Label htmlFor={`project-default-agent-${project.id}`}>{label}</Label>
      <Select value={saved} onValueChange={(value) => void save(value)} disabled={saving}>
        <SelectTrigger
          id={`project-default-agent-${project.id}`}
          aria-label={label}
          className="w-64"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="inherit">
            {translate('settings.projectDefaultAgent.inherit', 'Inherit global')}
          </SelectItem>
          <SelectItem value="blank">
            {translate('settings.projectDefaultAgent.blankTerminal', 'Blank Terminal')}
          </SelectItem>
          {getAgentCatalog().map((agent) => (
            <SelectItem key={agent.id} value={agent.id}>
              {agent.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground">
        {saved === 'inherit'
          ? translate(
              'settings.projectDefaultAgent.effectiveGlobal',
              'Current global default: {{value0}}',
              { value0: globalLabel }
            )
          : translate(
              'settings.projectDefaultAgent.futureLaunches',
              'Applies to new workspaces and agent launches in this project.'
            )}
      </p>
      {error ? (
        <div className="space-y-2">
          <p role="alert" className="text-xs text-destructive">
            {error.message}
          </p>
          <Button
            size="sm"
            variant="outline"
            disabled={saving}
            onClick={() => void save(error.value)}
          >
            {translate('settings.projectDefaultAgent.retry', 'Retry save')}
          </Button>
        </div>
      ) : null}
    </div>
  )
}
