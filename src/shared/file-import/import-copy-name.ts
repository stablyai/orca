/** The nth copy's name: name copy.ext, then name copy 2.ext. Dotfiles retain their whole stem. */
export function copyNameCandidate(originalName: string, copy: number): string {
  const dotIndex = originalName.lastIndexOf('.')
  const stem = dotIndex > 0 ? originalName.slice(0, dotIndex) : originalName
  const ext = dotIndex > 0 ? originalName.slice(dotIndex) : ''
  return copy <= 1 ? `${stem} copy${ext}` : `${stem} copy ${copy}${ext}`
}

/** Choose the first free sibling: name.ext, name copy.ext, name copy 2.ext. */
export async function deconflictCopyName(
  originalName: string,
  isTaken: (name: string) => Promise<boolean>
): Promise<string> {
  if (!(await isTaken(originalName))) {
    return originalName
  }
  let counter = 1
  while (counter < 10000) {
    const candidate = copyNameCandidate(originalName, counter)
    if (!(await isTaken(candidate))) {
      return candidate
    }
    counter += 1
  }
  throw new Error(
    `Could not generate a unique name for '${originalName}' after ${counter} attempts`
  )
}
