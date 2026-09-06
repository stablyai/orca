import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MOBILE_WEB_BRIDGE_OPERATIONS } from './bridge-operation-registry'

const PAGE_DIR = resolve(__dirname, '..', '..', 'mobile-web', 'src')

/** Result fields each page request client compares against its own request before resolving. A
 * shell that answers one workspace's request with another workspace's payload is caught here, so
 * losing a field silently re-opens that swap. */
const EXPECTED_ECHO_FIELDS: Record<string, readonly string[]> = {
  'account.consumeResetCredit': ['scope'],
  'file.directory': ['relativePath', 'workspaceId'],
  'file.list': ['workspaceId'],
  'file.markdownDraftRead': ['relativePath', 'tabId', 'workspaceId'],
  'file.markdownRead': ['relativePath', 'tabId', 'workspaceId'],
  'file.markdownSave': ['relativePath', 'tabId', 'workspaceId'],
  'file.read': ['relativePath', 'workspaceId'],
  'file.readChunk': ['offset', 'relativePath', 'workspaceId'],
  'file.readTerminalArtifactChunk': ['offset', 'tabId', 'token', 'workspaceId'],
  'file.resolveTerminalPath': ['workspaceId'],
  'file.search': ['workspaceId'],
  'file.write': ['byteLength', 'relativePath', 'revision', 'workspaceId'],
  'provider.manageReview': ['action', 'provider', 'reviewNumber', 'workspaceId'],
  'provider.mutateReview': ['provider', 'reviewNumber', 'workspaceId'],
  'provider.review': ['branch', 'observedHead', 'workspaceId'],
  'provider.reviewCreate': ['provider', 'workspaceId'],
  'provider.reviewCreationEligibility': ['branch', 'observedHead', 'workspaceId'],
  'provider.reviewDiff': [
    'branch',
    'observedHead',
    'path',
    'provider',
    'reviewHead',
    'reviewNumber',
    'workspaceId'
  ],
  'provider.reviewGenerateFields': ['workspaceId'],
  'provider.reviewQuery': ['provider', 'query', 'reviewNumber', 'workspaceId'],
  'provider.submitReview': [
    'action',
    'expectedReviewHead',
    'provider',
    'reviewNumber',
    'submissionId',
    'submittedCommentIds',
    'workspaceId'
  ],
  'session.activate': ['activeTabId', 'workspaceId'],
  'session.close': ['tabId', 'workspaceId'],
  'session.create': ['workspaceId'],
  'session.createAgent': ['workspaceId'],
  'session.createBrowser': ['workspaceId'],
  'session.createQuickCommand': ['workspaceId'],
  'session.snapshot': ['workspaceId'],
  'sourceControl.abort': ['operation', 'previousBranch', 'previousHead', 'workspaceId'],
  'sourceControl.branch': ['branch', 'operation', 'previousBranch', 'previousHead', 'workspaceId'],
  'sourceControl.branchCompare': ['baseRef', 'offset', 'revision', 'workspaceId'],
  'sourceControl.branches': ['workspaceId'],
  'sourceControl.cancelCommitMessageGeneration': ['workspaceId'],
  'sourceControl.commit': ['previousHead', 'workspaceId'],
  'sourceControl.commitCompare': ['commitId', 'workspaceId'],
  'sourceControl.diff': ['area', 'offset', 'relativePath', 'revision', 'workspaceId'],
  'sourceControl.discard': ['operation', 'relativePaths.length', 'workspaceId'],
  'sourceControl.fetch': ['operation', 'previousBranch', 'previousHead', 'workspaceId'],
  'sourceControl.generateCommitMessage': ['previousHead', 'workspaceId'],
  'sourceControl.history': ['limit', 'workspaceId'],
  'sourceControl.pull': ['operation', 'previousBranch', 'previousHead', 'workspaceId'],
  'sourceControl.push': ['operation', 'previousBranch', 'previousHead', 'workspaceId'],
  'sourceControl.rebase': ['operation', 'previousBranch', 'previousHead', 'workspaceId'],
  'sourceControl.reviewDiff': ['relativePath', 'scope', 'workspaceId'],
  'sourceControl.reviewLink': ['workspaceId'],
  'sourceControl.reviewLinkUpdate': ['workspaceId'],
  'sourceControl.reviewMetadata': ['workspaceId'],
  'sourceControl.reviewMetadataUpdate': ['workspaceId'],
  'sourceControl.stage': ['operation', 'relativePaths.length', 'workspaceId'],
  'sourceControl.status': ['workspaceId'],
  'sourceControl.unstage': ['operation', 'relativePaths.length', 'workspaceId'],
  'sourceControl.upstream': ['workspaceId'],
  'speech.configure': ['dictationMode', 'enabled', 'selectedModelId'],
  'task.loadLinearDetail': ['issue.targetId'],
  'task.loadLinearIssue': ['issue.targetId'],
  'task.projectTable': ['project', 'selectedView.id'],
  'task.resolveProjectRef': ['host'],
  'workspace.activate': ['workspaceId'],
  'workspace.creationSaveSparsePreset': ['directories', 'id', 'name', 'repoId'],
  'workspace.creationSparsePresets': ['repoId'],
  'workspace.creationSshConnect': ['targetId'],
  'workspace.creationSshState': ['targetId'],
  'workspace.remove': ['workspaceId'],
  'workspace.update': ['workspaceId']
}

/** Echo helpers shared across request clients, and the result fields each one compares. Resolved
 * by name because the derivation below only walks helpers defined in the same file. */
const SHARED_ECHO_HELPERS: Record<string, readonly string[]> = {
  requireEchoedWorkspaceId: ['workspaceId']
}

function balancedBody(text: string, from: number): string | null {
  let depth = 0
  let index = from
  let opened = false
  for (; index < text.length; index++) {
    const character = text[index]
    if (character === '(') {
      depth++
      opened = true
    } else if (character === ')') {
      depth--
      if (opened && depth === 0) {
        index++
        break
      }
    }
  }
  const start = text.indexOf('{', index)
  if (start === -1) {
    return null
  }
  let braces = 0
  for (let cursor = start; cursor < text.length; cursor++) {
    if (text[cursor] === '{') {
      braces++
    } else if (text[cursor] === '}') {
      braces--
      if (braces === 0) {
        return text.slice(start, cursor + 1)
      }
    }
  }
  return null
}

type Method = { name: string; body: string }

function readClient(name: string): { text: string; methods: Method[]; helpers: Method[] } {
  const text = readFileSync(join(PAGE_DIR, name), 'utf8')
  const lines = text.split('\n')
  const offsets: number[] = []
  let offset = 0
  for (const line of lines) {
    offsets.push(offset)
    offset += line.length + 1
  }
  const methods: Method[] = []
  for (let index = 0; index < lines.length; index++) {
    const match =
      /^ {2}(?:(?:private|protected|public|async)\s+)*([A-Za-z][A-Za-z0-9]*)\s*[(<]/.exec(
        lines[index]!
      )
    if (!match || /^\s*(?:if|for|while|switch|catch|return)\b/.test(lines[index]!)) {
      continue
    }
    const body = balancedBody(text, offsets[index]!)
    if (!body) {
      continue
    }
    methods.push({ name: match[1]!, body })
    index += body.split('\n').length - 1
  }
  const helpers: Method[] = []
  for (const match of text.matchAll(/\nfunction ([A-Za-z0-9_]+)\s*[<(]/g)) {
    const body = balancedBody(text, match.index + match[0].length - 1)
    if (body) {
      helpers.push({ name: match[1]!, body })
    }
  }
  return { text, methods, helpers }
}

/** Echo comparisons today, plus any `echo: [...]` declaration a factory-built method carries, so a
 * declarative rewrite that drops a field still shrinks this set. */
function echoFields(body: string, helpers: Method[], seen: Set<string>): Set<string> {
  const fields = new Set<string>()
  for (const match of body.matchAll(
    /\b(?:result|preset|value)\.((?:[A-Za-z0-9_]+\.)*[A-Za-z0-9_]+)\s*!==/g
  )) {
    fields.add(match[1]!)
  }
  for (const match of body.matchAll(
    /!same[A-Za-z0-9_]*\(\s*(?:result|preset|value)\.([A-Za-z0-9_]+)/g
  )) {
    fields.add(match[1]!)
  }
  for (const match of body.matchAll(/\becho:\s*\[([^\]]*)\]/g)) {
    for (const field of match[1]!.matchAll(/'([A-Za-z0-9_.]+)'/g)) {
      fields.add(field[1]!)
    }
  }
  for (const [helper, declared] of Object.entries(SHARED_ECHO_HELPERS)) {
    if (new RegExp(`\\b${helper}\\(`).test(body)) {
      for (const field of declared) {
        fields.add(field)
      }
    }
  }
  for (const match of body.matchAll(/\b((?:matching|same)[A-Za-z0-9_]*)\s*\(/g)) {
    const helper = helpers.find((candidate) => candidate.name === match[1])
    if (!helper || seen.has(helper.name)) {
      continue
    }
    seen.add(helper.name)
    for (const field of echoFields(helper.body, helpers, seen)) {
      fields.add(field)
    }
  }
  return fields
}

/** Operations a method names directly in a `request` call. */
function directOperations(body: string): string[] {
  return [...body.matchAll(/\.request\(\s*'([A-Za-z]+)',\s*'([A-Za-z0-9]+)'/g)].map(
    (match) => `${match[1]}.${match[2]}`
  )
}

/** Operations a method hands to a private helper that forwards a variable operation on. */
function forwardedOperations(body: string, forwarders: Map<string, string>): string[] {
  const operations: string[] = []
  for (const [helper, capability] of forwarders) {
    for (const match of body.matchAll(
      new RegExp(`\\bthis\\.${helper}(?:<[^(]*>)?\\(\\s*'([A-Za-z0-9]+)'`, 'g')
    )) {
      operations.push(`${capability}.${match[1]}`)
    }
  }
  return operations
}

function derivedEchoCensus(): Record<string, string[]> {
  const census: Record<string, Set<string>> = {}
  const files = readdirSync(PAGE_DIR).filter(
    (name) => name.endsWith('-request-client.ts') && !name.includes('.test.')
  )
  for (const name of files) {
    const { methods, helpers } = readClient(name)
    const forwarders = new Map<string, string>()
    for (const method of methods) {
      const match = /\.request\(\s*'([A-Za-z]+)',\s*(?!')[A-Za-z]/.exec(method.body)
      if (match) {
        forwarders.set(method.name, match[1]!)
      }
    }
    const forwarderFields = new Map<string, Set<string>>()
    for (const method of methods) {
      const fields = echoFields(method.body, helpers, new Set())
      if (forwarders.has(method.name)) {
        forwarderFields.set(method.name, fields)
        continue
      }
      if (fields.size === 0) {
        continue
      }
      for (const operation of [
        ...directOperations(method.body),
        ...forwardedOperations(method.body, forwarders)
      ]) {
        census[operation] = new Set([...(census[operation] ?? []), ...fields])
      }
    }
    for (const [helper, fields] of forwarderFields) {
      if (fields.size === 0) {
        continue
      }
      for (const method of methods) {
        if (method.name === helper) {
          continue
        }
        for (const operation of forwardedOperations(
          method.body,
          new Map([[helper, forwarders.get(helper)!]])
        )) {
          census[operation] = new Set([...(census[operation] ?? []), ...fields])
        }
      }
    }
  }
  return Object.fromEntries(
    Object.entries(census).map(([operation, fields]) => [operation, [...fields].sort()])
  )
}

describe('mobile web bridge operation echo census', () => {
  const derived = derivedEchoCensus()

  it('checks the recorded echo fields on every operation that guards its own identity', () => {
    expect(derived).toEqual(
      Object.fromEntries(
        Object.entries(EXPECTED_ECHO_FIELDS).map(([operation, fields]) => [operation, [...fields]])
      )
    )
  })

  it('keeps every shared echo helper checking the fields it is credited with', () => {
    const text = readFileSync(join(PAGE_DIR, 'mobile-web-result-echo.ts'), 'utf8')

    for (const [helper, declared] of Object.entries(SHARED_ECHO_HELPERS)) {
      expect(text).toContain(`export function ${helper}`)
      for (const field of declared) {
        expect(text).toContain(`result.${field} !==`)
      }
    }
  })

  it('records echo fields only for registered operations', () => {
    const registered = new Set(
      Object.entries(MOBILE_WEB_BRIDGE_OPERATIONS).flatMap(([capability, operations]) =>
        Object.keys(operations).map((operation) => `${capability}.${operation}`)
      )
    )

    expect(Object.keys(EXPECTED_ECHO_FIELDS).filter((key) => !registered.has(key))).toEqual([])
    expect(Object.keys(EXPECTED_ECHO_FIELDS).length).toBeGreaterThanOrEqual(60)
  })

  it('guards the page workspace handle on every workspace-scoped echo it records', () => {
    const workspaceScoped = Object.entries(EXPECTED_ECHO_FIELDS).filter(([, fields]) =>
      fields.some((field) => field === 'workspaceId')
    )

    expect(workspaceScoped.length).toBeGreaterThanOrEqual(40)
  })
})
