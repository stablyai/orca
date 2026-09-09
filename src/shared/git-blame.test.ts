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

	it('does not merge matching metadata across a different intervening commit', () => {
		const first = 'a'.repeat(40)
		const second = 'b'.repeat(40)
		const output = `${first} 1 1 1\nauthor One\nauthor-mail <one@example.com>\nauthor-time 1700000000\nsummary repeated\n\tone\n${second} 2 2 1\nauthor Two\nauthor-mail <two@example.com>\nauthor-time 1700000001\nsummary middle\n\ttwo\n${first} 3 3 1\n\tthree\n`

		expect(parseGitBlamePorcelain(output).ranges).toMatchObject([
			{ startLine: 1, endLine: 1, commitId: first },
			{ startLine: 2, endLine: 2, commitId: second },
			{ startLine: 3, endLine: 3, commitId: first }
		])
	})
})
