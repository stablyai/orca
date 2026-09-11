import type { JiraAuthType } from '../../../shared/jira-types'
import { translate } from '@/i18n/i18n'

export type JiraInstanceType = 'cloud' | 'server'
// Self-hosted Jira accepts either a personal access token (Bearer) or classic
// username + password (Basic); older Server/DC instances predate PATs.
export type ServerAuthMethod = 'pat' | 'basic'
// Atlassian Cloud tokens come in two shapes: classic (Basic auth on the site
// host) and scoped (only honoured by the api.atlassian.com gateway).
export type CloudTokenKind = 'classic' | 'scoped'

export type JiraConnectMode = {
  instanceType: JiraInstanceType
  serverAuthMethod: ServerAuthMethod
  cloudTokenKind: CloudTokenKind
}

export const DEFAULT_JIRA_CONNECT_MODE: JiraConnectMode = {
  instanceType: 'cloud',
  serverAuthMethod: 'pat',
  cloudTokenKind: 'classic'
}

export type JiraConnectModeShape = {
  isServer: boolean
  isServerBasic: boolean
  isScopedCloud: boolean
  // The identity slot (Cloud email / Server username) keys and labels the stored
  // site, so it is required whenever it is sent as part of Basic auth.
  needsIdentity: boolean
  // A scoped Cloud token shows the field but keeps it optional: Basic with an
  // email, Bearer without.
  showsIdentity: boolean
  authType: JiraAuthType
}

export function describeJiraConnectMode(mode: JiraConnectMode): JiraConnectModeShape {
  const isServer = mode.instanceType === 'server'
  const isServerBasic = isServer && mode.serverAuthMethod === 'basic'
  const isScopedCloud = !isServer && mode.cloudTokenKind === 'scoped'
  const needsIdentity = (!isServer && !isScopedCloud) || isServerBasic
  return {
    isServer,
    isServerBasic,
    isScopedCloud,
    needsIdentity,
    showsIdentity: needsIdentity || isScopedCloud,
    authType: isServer ? 'server' : isScopedCloud ? 'cloud-scoped' : 'cloud'
  }
}

export type JiraConnectCopy = {
  description: string
  siteUrlLabel: string
  siteUrlPlaceholder: string
  identityLabel: string
  identityPlaceholder: string
  identityInputType: 'text' | 'email'
  tokenLabel: string
  tokenPlaceholder: string
}

function describeMode(shape: JiraConnectModeShape): string {
  if (shape.isScopedCloud) {
    return translate(
      'auto.components.jira.connect.dialog.8e851d7ba0',
      'Use a Jira Cloud site URL and a scoped API token; Orca calls the api.atlassian.com gateway on its behalf.'
    )
  }
  if (!shape.isServer) {
    return translate(
      'auto.components.jira.connect.dialog.d785c42b8b',
      'Use a Jira Cloud site URL, Atlassian email, and API token to browse issues.'
    )
  }
  return shape.isServerBasic
    ? translate(
        'auto.components.jira.connect.dialog.1d947a07ab',
        'Use a self-hosted Jira base URL, username, and password to browse issues.'
      )
    : translate(
        'auto.components.jira.connect.dialog.2e2b69e48e',
        'Use a self-hosted Jira base URL and a personal access token to browse issues.'
      )
}

function tokenLabel(shape: JiraConnectModeShape): string {
  if (shape.isServerBasic) {
    return translate('auto.components.jira.connect.dialog.70035652d7', 'Password')
  }
  if (shape.isServer) {
    return translate('auto.components.jira.connect.dialog.730d973bae', 'Personal access token')
  }
  return shape.isScopedCloud
    ? translate('auto.components.jira.connect.dialog.327c8aeb62', 'Scoped API token')
    : translate('auto.components.jira.connect.dialog.3d81bf3ab3', 'API token')
}

function tokenPlaceholder(shape: JiraConnectModeShape): string {
  if (shape.isServerBasic) {
    return translate('auto.components.jira.connect.dialog.c50abbf340', 'Jira account password')
  }
  if (shape.isServer) {
    return translate('auto.components.jira.connect.dialog.8b9c7b9e7b', 'Jira personal access token')
  }
  return shape.isScopedCloud
    ? translate('auto.components.jira.connect.dialog.8d9f6669a7', 'Atlassian API token with scopes')
    : translate('auto.components.jira.connect.dialog.7b3967c12f', 'Atlassian API token')
}

export function jiraConnectCopy(shape: JiraConnectModeShape): JiraConnectCopy {
  return {
    description: describeMode(shape),
    siteUrlLabel: shape.isServer
      ? translate('auto.components.jira.connect.dialog.3489e186d6', 'Jira site URL')
      : translate('auto.components.jira.connect.dialog.e176f9d0c5', 'Jira Cloud site URL'),
    siteUrlPlaceholder: shape.isServer
      ? translate('auto.components.jira.connect.dialog.cbc27fa599', 'https://jira.example.com')
      : translate(
          'auto.components.jira.connect.dialog.70fcd360c4',
          'https://example.atlassian.net'
        ),
    identityLabel: shape.isServerBasic
      ? translate('auto.components.jira.connect.dialog.8d1223fa5c', 'Username')
      : shape.isScopedCloud
        ? translate('auto.components.jira.connect.dialog.b4303bfe5a', 'Atlassian email (optional)')
        : translate('auto.components.jira.connect.dialog.2849ddb295', 'Atlassian email'),
    identityPlaceholder: shape.isServerBasic
      ? translate('auto.components.jira.connect.dialog.be9eba0a1b', 'username')
      : translate('auto.components.jira.connect.dialog.e91b9a4073', 'you@example.com'),
    identityInputType: shape.isServerBasic ? 'text' : 'email',
    tokenLabel: tokenLabel(shape),
    tokenPlaceholder: tokenPlaceholder(shape)
  }
}
