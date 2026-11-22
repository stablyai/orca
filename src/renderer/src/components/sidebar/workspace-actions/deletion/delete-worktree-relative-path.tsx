import { Fragment, type JSX } from 'react'

export function isDirectoryDisplayPath(rawPath: string): boolean {
  return rawPath.endsWith('/') || rawPath.endsWith('\\')
}

type DirectorySegment = {
  prefixKey: string
  text: string
}

function splitDirectoryAndLeaf(rawPath: string): {
  directorySegments: DirectorySegment[]
  leafName: string
} {
  const isDirectory = isDirectoryDisplayPath(rawPath)
  const trimmed = isDirectory ? rawPath.slice(0, -1) : rawPath
  const lastSlashIndex = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  if (lastSlashIndex < 0) {
    return { directorySegments: [], leafName: rawPath }
  }
  const directoryPrefix = trimmed.slice(0, lastSlashIndex + 1)
  // Keep trailing separators on each segment so long paths wrap at `/` before mid-filename.
  const matches = [...directoryPrefix.matchAll(/[^/\\]+[/\\]+/g)]
  const directorySegments =
    matches.length > 0
      ? matches.map((match) => ({
          prefixKey: directoryPrefix.slice(0, (match.index ?? 0) + match[0].length),
          text: match[0]
        }))
      : [{ prefixKey: directoryPrefix, text: directoryPrefix }]
  return {
    directorySegments,
    leafName: rawPath.slice(lastSlashIndex + 1)
  }
}

export function DeleteWorktreeRelativePath({ path }: { path: string }): JSX.Element {
  const { directorySegments, leafName } = splitDirectoryAndLeaf(path)
  return (
    <>
      {directorySegments.length > 0 ? (
        <span className="text-muted-foreground">
          {directorySegments.map((segment) => (
            <Fragment key={segment.prefixKey}>
              {segment.text}
              <wbr />
            </Fragment>
          ))}
        </span>
      ) : null}
      {leafName}
    </>
  )
}
