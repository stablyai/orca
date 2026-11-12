/** A vs-ssh remote's org becomes the API hostname that receives the PAT, so only plain org names pass. */
export function isAzureDevOpsOrganizationName(value: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(value)
}
