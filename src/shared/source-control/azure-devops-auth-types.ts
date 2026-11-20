export type AzureDevOpsAuthMethod = 'environment' | 'azure-cli'

export function normalizeAzureDevOpsAuthMethod(value: unknown): AzureDevOpsAuthMethod {
  return value === 'azure-cli' ? 'azure-cli' : 'environment'
}
