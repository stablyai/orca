export type ParsedPullRequestReference = {
  repoName: string
  number: number
  url?: string
  /** Known only for URL references; `repo#n` stays provider-neutral. */
  provider?: 'github' | 'gitlab'
  // why: URL references name the hosting repo; a same-named local repo may point at another owner
  owner?: string
  host?: string
}

const GITHUB_PR = /^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/
const GITLAB_MR = /^https?:\/\/([^/]+)\/((?:[^/]+\/)*[^/]+)\/([^/]+)\/-\/merge_requests\/(\d+)\/?$/
const SHORT_REF = /^([A-Za-z0-9._-]+)#(\d+)$/

export function parsePullRequestReference(input: string): ParsedPullRequestReference | null {
  const text = input.trim()
  const github = GITHUB_PR.exec(text)
  if (github) {
    return {
      repoName: github[3],
      number: Number(github[4]),
      url: text,
      provider: 'github',
      owner: github[2],
      host: github[1].toLowerCase()
    }
  }
  const gitlab = GITLAB_MR.exec(text)
  if (gitlab) {
    return {
      repoName: gitlab[3],
      number: Number(gitlab[4]),
      url: text,
      provider: 'gitlab',
      owner: gitlab[2],
      host: gitlab[1].toLowerCase()
    }
  }
  const short = SHORT_REF.exec(text)
  return short ? { repoName: short[1], number: Number(short[2]) } : null
}
