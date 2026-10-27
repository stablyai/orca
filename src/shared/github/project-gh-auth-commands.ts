// Main's English errors and the desktop's translated copy both embed these, so the commands stay identical.
export function projectGhLoginCommand(host: string): string {
  return `gh auth login --hostname ${host}`
}

export function projectGhRefreshCommand(host: string): string {
  return `gh auth refresh --hostname ${host} -s project -s read:org -s repo`
}
