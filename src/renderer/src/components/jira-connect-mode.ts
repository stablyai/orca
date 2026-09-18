import type { JiraAuthType } from '../../../shared/jira-types'
import { translate } from '@/i18n/i18n'

export type JiraInstanceType = 'cloud' | 'server'
// Self-hosted Jira accepts either a personal access token (Bearer) or classic
// username + password (Basic); older Server/DC instances predate PATs.
export type ServerAuthMethod = 'pat' | 'basic'

export type JiraConnectMode = {
  instanceType: JiraInstanceType
  serverAuthMethod: ServerAuthMethod
}

export const DEFAULT_JIRA_CONNECT_MODE: JiraConnectMode = {
  instanceType: 'cloud',
  serverAuthMethod: 'pat'
}

export type JiraConnectModeShape = {
  isServer: boolean
  isServerBasic: boolean
  // Folds "Cloud Atlassian email" and "self-hosted Basic username": the identity
  // slot that keys and labels the stored site. PAT auth sends no identity.
  needsIdentity: boolean
  // Cloud covers classic and scoped tokens alike; main picks the host on connect.
  authType: JiraAuthType
}

export function describeJiraConnectMode(mode: JiraConnectMode): JiraConnectModeShape {
  const isServer = mode.instanceType === 'server'
  const isServerBasic = isServer && mode.serverAuthMethod === 'basic'
  return {
    isServer,
    isServerBasic,
    needsIdentity: !isServer || isServerBasic,
    authType: isServer ? 'server' : 'cloud'
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
  return shape.isServer
    ? translate('auto.components.jira.connect.dialog.730d973bae', 'Personal access token')
    : translate('auto.components.jira.connect.dialog.3d81bf3ab3', 'API token')
}

function tokenPlaceholder(shape: JiraConnectModeShape): string {
  if (shape.isServerBasic) {
    return translate('auto.components.jira.connect.dialog.c50abbf340', 'Jira account password')
  }
  return shape.isServer
    ? translate('auto.components.jira.connect.dialog.8b9c7b9e7b', 'Jira personal access token')
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
      : translate('auto.components.jira.connect.dialog.2849ddb295', 'Atlassian email'),
    identityPlaceholder: shape.isServerBasic
      ? translate('auto.components.jira.connect.dialog.be9eba0a1b', 'username')
      : translate('auto.components.jira.connect.dialog.e91b9a4073', 'you@example.com'),
    identityInputType: shape.isServerBasic ? 'text' : 'email',
    tokenLabel: tokenLabel(shape),
    tokenPlaceholder: tokenPlaceholder(shape)
  }
}
