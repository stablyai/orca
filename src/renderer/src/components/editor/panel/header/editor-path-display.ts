export function splitPathForDisplay(path: string): { prefix: string; fileName: string } {
  const separatorIndex = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  if (separatorIndex < 0) {
    return { prefix: '', fileName: path }
  }
  return {
    prefix: path.slice(0, separatorIndex + 1),
    fileName: path.slice(separatorIndex + 1)
  }
}
