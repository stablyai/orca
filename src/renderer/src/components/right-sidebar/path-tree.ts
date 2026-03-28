export function splitPathSegments(path: string): string[] {
  return path.split(/[\\/]+/).filter(Boolean)
}
