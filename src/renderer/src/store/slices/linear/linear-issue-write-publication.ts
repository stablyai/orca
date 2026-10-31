import type { LinearIssue } from '../../../../../shared/linear/issue-types'
import type { LinearWorkspace } from '../../../../../shared/linear/workspace-types'
import type { LinearReadScope } from './linear-slice-scope'
import { reads, scopedReads, notifyPublication } from './linear-issue-read-lifecycle'

type Field =
  | 'state'
  | 'priority'
  | 'estimate'
  | 'assignee'
  | 'labels'
  | 'title'
  | 'description'
  | 'project'
type Delta = Partial<LinearIssue>
type Contribution = { operation?: object; value: Delta }
type FieldGroup = { base: Delta; contributions: Contribution[] }
export type IssueOwner = {
  id: string
  workspaceId?: string
  organizationId?: string
  fields: Map<Field, FieldGroup>
}
export const pendingLinearIssueWrites = new Map<string, Map<string, IssueOwner>>()
export type LinearIssuePublication = {
  <T extends Delta>(previous: T): T
  fields: readonly Field[]
  patch: Delta
  current: (field: string) => boolean
}
type LocalConsumer = {
  tokens: Map<Field, object>
  publish: (apply: LinearIssuePublication) => void
}
const localConsumers = new Map<string, Map<string, Set<LocalConsumer>>>()
const fields: Field[] = [
  'state',
  'priority',
  'estimate',
  'assignee',
  'labels',
  'title',
  'description'
]

function fieldValue(issue: Delta, field: Field): Delta {
  return field === 'labels'
    ? { labels: issue.labels, labelIds: issue.labelIds }
    : { [field]: issue[field] }
}
function value(group: FieldGroup): Delta {
  return group.contributions.at(-1)?.value ?? group.base
}
function ownerMap(scope: LinearReadScope) {
  return pendingLinearIssueWrites.get(scope.contextKey)
}
export function knownLinearOrganization(
  workspace: LinearWorkspace | undefined
): string | undefined {
  return workspace?.isLegacy && workspace.organizationId === workspace.id
    ? undefined
    : workspace?.organizationId
}
export function projectLinearIssue(scope: LinearReadScope, issue: LinearIssue): LinearIssue {
  const owner = ownerMap(scope)?.get(issue.id)
  if (!owner) {
    return issue
  }
  const patch = Object.assign({}, ...[...owner.fields.values()].map(value))
  return { ...issue, ...patch }
}
export function registerLinearIssueConsumer(
  scope: LinearReadScope,
  id: string,
  publish: LocalConsumer['publish']
): { release: () => void; capture: () => () => void } {
  let byIssue = localConsumers.get(scope.contextKey)
  if (!byIssue) {
    byIssue = new Map()
    localConsumers.set(scope.contextKey, byIssue)
  }
  let consumers = byIssue.get(id)
  if (!consumers) {
    consumers = new Set()
    byIssue.set(id, consumers)
  }
  const consumer: LocalConsumer = { tokens: new Map(), publish }
  consumers.add(consumer)
  const owner = ownerMap(scope)?.get(id)
  if (owner) {
    publishConsumer(consumer, Object.assign({}, ...[...owner.fields.values()].map(value)))
  }
  return {
    capture: () => {
      const captured = [...consumer.tokens]
      return () => {
        for (const [field, token] of captured) {
          if (consumer.tokens.get(field) === token) {
            consumer.tokens.delete(field)
          }
        }
      }
    },
    release: () => {
      consumer.tokens.clear()
      consumers.delete(consumer)
      if (!consumers.size) {
        byIssue.delete(id)
      }
      if (!byIssue.size) {
        localConsumers.delete(scope.contextKey)
      }
    }
  }
}
function publishConsumer(consumer: LocalConsumer, patch: Delta) {
  const token = {}
  const changed = [...fields, 'project' as const].filter((field) => Object.hasOwn(patch, field))
  for (const field of changed) {
    consumer.tokens.set(field, token)
  }
  const apply = <T extends Delta>(previous: T): T => {
    const current = changed.filter((field) => consumer.tokens.get(field) === token)
    return current.length
      ? { ...previous, ...Object.assign({}, ...current.map((field) => fieldValue(patch, field))) }
      : previous
  }
  notifyPublication(() =>
    consumer.publish(
      Object.assign(apply, {
        fields: changed,
        patch,
        current: (field: string) =>
          changed.some((key) => key === field && consumer.tokens.get(key) === token)
      })
    )
  )
}
function publishLocal(scope: LinearReadScope, id: string, patch: Delta) {
  for (const consumer of localConsumers.get(scope.contextKey)?.get(id) ?? []) {
    publishConsumer(consumer, patch)
  }
}

function retire(scope: LinearReadScope, id: string, confirmed = false) {
  for (const read of scopedReads(scope)) {
    notifyPublication(() => read.edge(id, confirmed))
  }
}

export function confirmLinearIssueWrite(args: {
  scope: LinearReadScope
  id: string
  patch?: Delta
  publish?: () => void
}) {
  if (!args.scope.isCurrentRuntime()) {
    return
  }
  retire(args.scope, args.id, true)
  try {
    if (args.publish) {
      notifyPublication(args.publish)
    }
    if (args.patch) {
      publishLocal(args.scope, args.id, args.patch)
    }
  } finally {
    for (const read of scopedReads(args.scope)) {
      notifyPublication(() => read.drain())
    }
  }
}

export async function runLinearIssueWrite<T extends { ok: boolean }>(args: {
  scope: LinearReadScope
  issue: LinearIssue
  patch: Delta
  organizationId?: string
  publish: (patch: Delta) => void
  mutate: () => Promise<T>
}): Promise<T> {
  const { scope, issue, patch } = args
  let byIssue = ownerMap(scope)
  if (!byIssue) {
    byIssue = new Map()
    pendingLinearIssueWrites.set(scope.contextKey, byIssue)
  }
  let owner = byIssue.get(issue.id)
  if (!owner) {
    owner = {
      id: issue.id,
      workspaceId: issue.workspaceId,
      organizationId: args.organizationId,
      fields: new Map()
    }
    byIssue.set(issue.id, owner)
  }
  const operation = {}
  const enrolled: FieldGroup[] = []
  for (const field of fields) {
    if (!Object.hasOwn(patch, field)) {
      continue
    }
    let group = owner.fields.get(field)
    if (!group) {
      group = { base: fieldValue(issue, field), contributions: [] }
      owner.fields.set(field, group)
    }
    group.contributions.push({ operation, value: fieldValue(patch, field) })
    enrolled.push(group)
  }
  let succeeded = false
  try {
    retire(scope, issue.id)
    notifyPublication(() => args.publish(patch))
    publishLocal(scope, issue.id, patch)
    const result = await args.mutate()
    succeeded = result.ok
    return result
  } finally {
    const attached =
      pendingLinearIssueWrites.get(scope.contextKey) === byIssue && scope.isCurrentRuntime()
    if (attached) {
      retire(scope, issue.id)
    }
    const delta: Delta = {}
    for (const [field, group] of owner.fields) {
      if (!enrolled.includes(group)) {
        continue
      }
      const index = group.contributions.findIndex((entry) => entry.operation === operation)
      if (index === -1) {
        continue
      }
      if (succeeded && !group.contributions.slice(index + 1).some((entry) => !entry.operation)) {
        group.contributions[index] = { value: group.contributions[index].value }
        group.contributions = group.contributions.filter(
          (entry, position) => entry.operation || position === index
        )
      } else {
        group.contributions.splice(index, 1)
      }
      Object.assign(delta, value(group))
      if (!group.contributions.some((entry) => entry.operation)) {
        owner.fields.delete(field)
      }
    }
    if (!owner.fields.size) {
      byIssue.delete(issue.id)
    }
    if (!byIssue.size && pendingLinearIssueWrites.get(scope.contextKey) === byIssue) {
      pendingLinearIssueWrites.delete(scope.contextKey)
    }
    try {
      if (attached) {
        notifyPublication(() => args.publish(delta))
        publishLocal(scope, issue.id, delta)
      }
    } finally {
      if (attached) {
        for (const read of scopedReads(scope)) {
          notifyPublication(() => read.drain())
        }
      }
    }
  }
}

export function detachLinearIssuePublication(scope: LinearReadScope, allSources = false) {
  const affected = (key: string) =>
    key === scope.contextKey ||
    (allSources &&
      (key === scope.runtimeContextKey || key.startsWith(`${scope.runtimeContextKey}::`)))
  for (const key of pendingLinearIssueWrites.keys()) {
    if (affected(key)) {
      pendingLinearIssueWrites.delete(key)
    }
  }
  for (const [key, byIssue] of localConsumers) {
    if (!affected(key)) {
      continue
    }
    for (const consumers of byIssue.values()) {
      for (const consumer of consumers) {
        consumer.tokens.clear()
      }
    }
  }
  // oxlint-disable-next-line unicorn/no-useless-spread -- Why: abandonment callbacks can replace demand while old scopes are removed.
  for (const [key, scoped] of [...reads]) {
    if (affected(key)) {
      // oxlint-disable-next-line unicorn/no-useless-spread -- Why: abandon can synchronously replace demand.
      for (const read of [...scoped]) {
        read.abandon()
      }
    }
  }
}
