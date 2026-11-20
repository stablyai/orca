const PROJECT_SCOPE_FLAGS = '-s project -s read:org -s repo'

export function ghAuthLoginCommand(host?: string): string {
  return host ? `gh auth login --hostname ${host}` : 'gh auth login'
}

export function ghAuthRefreshCommand(host?: string): string {
  return host
    ? `gh auth refresh --hostname ${host} ${PROJECT_SCOPE_FLAGS}`
    : `gh auth refresh ${PROJECT_SCOPE_FLAGS}`
}
