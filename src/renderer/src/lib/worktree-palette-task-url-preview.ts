export type CmdJTaskUrlCreatePreview = {
  provider: 'github' | 'gitlab' | 'gitea' | 'jira'
  identifier: string
  subtitle: string
  createLabel: string
  kindLabel: string
  loading?: boolean
}

export function withResolvedCmdJGitHubPreview(
  preview: CmdJTaskUrlCreatePreview,
  resolvedTitle: string | null,
  loading: boolean
): CmdJTaskUrlCreatePreview {
  if (preview.provider !== 'github') {
    return preview
  }
  if (resolvedTitle) {
    return {
      ...preview,
      subtitle: resolvedTitle,
      createLabel: `${preview.createLabel}: ${resolvedTitle}`,
      loading: false
    }
  }
  return loading ? { ...preview, loading: true } : preview
}
