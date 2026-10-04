// Preserve host path spelling: these paths can belong to Windows, WSL or SSH.
export function dshHomeFromSessionPath(path: string | null | undefined): string | null {
  return (
    path?.match(
      /^(.*)[\\/]sessions[\\/][^\\/]+[\\/][^\\/]+[\\/]session(?:\.v[1-9]\d*)?\.jsonl(?:\.zstd)?$/
    )?.[1] || null
  )
}
