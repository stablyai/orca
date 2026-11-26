const MAX_FILTER_LABELS = 50
// GitLab limits a label title to 255 characters, not bytes.
const MAX_LABEL_NAME_LENGTH = 255

export function isGitLabLabelFilterName(name: unknown): name is string {
  return (
    typeof name === 'string' &&
    name !== '' &&
    // Requests trim names, so one with outer whitespace would no longer match its picker option.
    name === name.trim() &&
    // GitLab joins label lists with commas, so a comma cannot be part of one name.
    !name.includes(',') &&
    // A line break ends the CSV value glab reads from --label, dropping the labels after it.
    ![...name].some((char) => char < ' ') &&
    [...name].length <= MAX_LABEL_NAME_LENGTH &&
    name.isWellFormed()
  )
}

export function normalizeGitLabLabelNames(value: unknown): string[] {
  const names = new Set<string>()
  for (const candidate of Array.isArray(value) ? value : []) {
    const name: unknown = typeof candidate === 'string' ? candidate.trim() : candidate
    if (isGitLabLabelFilterName(name)) {
      names.add(name)
    }
  }
  return [...names].slice(0, MAX_FILTER_LABELS)
}
