export const GIT_BLAME_RUNTIME_CAPABILITY = 'git.blame.v1' as const

export type GitBlameRange = {
	startLine: number
	endLine: number
	commitId: string | null
	author: string
	authorEmail: string
	authoredAt: number
	summary: string
}

export type GitBlameResult = { ranges: GitBlameRange[] }

type BlameMetadata = Omit<GitBlameRange, 'startLine' | 'endLine' | 'commitId'>

const HEADER = /^([0-9a-f]{40}|[0-9a-f]{64}) \d+ (\d+)(?: (\d+))?$/

export function parseGitBlamePorcelain(output: string): GitBlameResult {
	const lines = output.split('\n')
	const metadataByCommit = new Map<string, BlameMetadata>()
	const parsed: GitBlameRange[] = []

	for (let index = 0; index < lines.length;) {
		const header = HEADER.exec(lines[index] ?? '')
		if (!header) {
			index += 1
			continue
		}
		const rawCommitId = header[1]
		const startLine = Number(header[2])
		const fields: Record<string, string> = {}
		index += 1
		while (index < lines.length && !(lines[index] ?? '').startsWith('\t')) {
			if (HEADER.test(lines[index] ?? '')) {
				break
			}
			const separator = (lines[index] ?? '').indexOf(' ')
			if (separator > 0) {
				fields[(lines[index] ?? '').slice(0, separator)] = (lines[index] ?? '').slice(separator + 1)
			}
			index += 1
		}
		if ((lines[index] ?? '').startsWith('\t')) {
			index += 1
		}

		const prior = metadataByCommit.get(rawCommitId)
		const metadata: BlameMetadata = {
			author: fields.author ?? prior?.author ?? '',
			authorEmail: (fields['author-mail'] ?? prior?.authorEmail ?? '').replace(/^<|>$/g, ''),
			authoredAt: Number(fields['author-time'] ?? prior?.authoredAt ?? 0),
			summary: fields.summary ?? prior?.summary ?? ''
		}
		metadataByCommit.set(rawCommitId, metadata)
		parsed.push({
			startLine,
			endLine: startLine,
			commitId: /^0+$/.test(rawCommitId) ? null : rawCommitId,
			...metadata
		})
	}

	return { ranges: mergeAdjacentBlameRanges(parsed) }
}

function mergeAdjacentBlameRanges(ranges: GitBlameRange[]): GitBlameRange[] {
	const merged: GitBlameRange[] = []
	for (const range of ranges) {
		const previous = merged.at(-1)
		if (
			previous &&
			previous.endLine + 1 === range.startLine &&
			previous.commitId === range.commitId &&
			previous.author === range.author &&
			previous.authorEmail === range.authorEmail &&
			previous.authoredAt === range.authoredAt &&
			previous.summary === range.summary
		) {
			previous.endLine = range.endLine
		} else {
			merged.push({ ...range })
		}
	}
	return merged
}
