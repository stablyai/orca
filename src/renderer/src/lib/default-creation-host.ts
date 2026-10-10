import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { TaskSourceContext } from '../../../shared/task-source-context'
import type { RuntimeClientTarget } from '@/runtime/runtime-client-target'
import { taskSourceRuntimeTarget } from './task-source-runtime-target'

type DefaultHostSettings = Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined

// The one read of the setting; the exported readers below are the sanctioned ways to reach it.
function readDefaultHost(settings: DefaultHostSettings): RuntimeClientTarget {
  const environmentId = settings?.activeRuntimeEnvironmentId?.trim()
  return environmentId ? { kind: 'environment', environmentId } : { kind: 'local' }
}

/**
 * The "Default host for new projects" setting. Only a creation flow with no source row reads it;
 * everything else routes by the resource's owner.
 */
export function defaultCreationHost(settings: DefaultHostSettings): RuntimeClientTarget {
  return readDefaultHost(settings)
}

/**
 * Initial host of a row-less source (Linear, Jira, the status-bar account switchers) or a settings
 * scope, until the page's own host picker overrides it.
 */
export function defaultScopeHost(settings: DefaultHostSettings): RuntimeClientTarget {
  return readDefaultHost(settings)
}

/** "No source chosen yet": a row-less source that runs on the default scope host. */
export type DefaultScopeSource = { kind: 'default-scope'; settings: DefaultHostSettings }

export function defaultScopeSource(settings: DefaultHostSettings): DefaultScopeSource {
  return { kind: 'default-scope', settings }
}

/** A row-less source: its task-source context, an explicit host, or the default scope host. */
export type RowLessSource = TaskSourceContext | RuntimeClientTarget | DefaultScopeSource

export function rowLessSourceTarget(source: RowLessSource): RuntimeClientTarget {
  if (source.kind === 'task-source') {
    return taskSourceRuntimeTarget(source)
  }
  return source.kind === 'default-scope' ? readDefaultHost(source.settings) : source
}
