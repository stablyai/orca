import { describe, expect, it } from 'vitest'
import { parseGitBlamePorcelain } from './git-blame'

describe('parseGitBlamePorcelain', () => {
	it.each([40, 64])('parses and groups %i-character object ids', (length) => {
		const oid = 'a'.repeat(length)
		const output = `${oid} 1 1 2\nauthor Zoë 李\nauthor-mail <zoe@example.com>\nauthor-time 1700000000\nsummary first\n\tone\n${oid} 2 2\n\ttwo\n`
		expect(parseGitBlamePorcelain(output)).toEqual({
			ranges: [
				{
					startLine: 1,
					endLine: 2,
					commitId: oid,
					author: 'Zoë 李',
					authorEmail: 'zoe@example.com',
					authoredAt: 1700000000,
					summary: 'first'
				}
			]
		})
	})

	it('maps the zero object id to uncommitted lines', () => {
		const output = `${'0'.repeat(40)} 1 3 1\nauthor Not Committed Yet\nauthor-mail <not.committed.yet>\nauthor-time 0\nsummary Version of file.txt from file.txt\n\tchanged\n`
		expect(parseGitBlamePorcelain(output).ranges[0]).toMatchObject({
			startLine: 3,
			endLine: 3,
			commitId: null
		})
	})
})
