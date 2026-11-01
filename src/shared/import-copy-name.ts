/** Choose the first free sibling: name.ext, name copy.ext, name copy 2.ext. Dotfiles retain their whole stem. */
export async function deconflictCopyName(
  originalName: string,
  isTaken: (name: string) => Promise<boolean>
): Promise<string> {
  if (!(await isTaken(originalName))) {
    return originalName
  }
  const dotIndex = originalName.lastIndexOf('.')
  const stem = dotIndex > 0 ? originalName.slice(0, dotIndex) : originalName
  const ext = dotIndex > 0 ? originalName.slice(dotIndex) : ''
  const firstCopy = `${stem} copy${ext}`
  if (!(await isTaken(firstCopy))) {
    return firstCopy
  }
  let counter = 2
  while (counter < 10000) {
    const candidate = `${stem} copy ${counter}${ext}`
    if (!(await isTaken(candidate))) {
      return candidate
    }
    counter += 1
  }
  throw new Error(
    `Could not generate a unique name for '${originalName}' after ${counter} attempts`
  )
}
