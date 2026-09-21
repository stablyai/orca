import { describe, expect, it } from 'vitest'
import {
  isSkillRunnableFile,
  summarizeSkillInstallRisk,
  type SkillInstallRiskFile
} from './skill-package-install-risk'

function file(
  path: string,
  options: { classification?: 'text' | 'binary'; executable?: boolean } = {}
): SkillInstallRiskFile {
  return {
    path,
    classification: options.classification ?? 'text',
    executable: options.executable ?? false
  }
}

describe('isSkillRunnableFile', () => {
  it('recognizes scripts outside the scripts folder and executable files without extensions', () => {
    expect(isSkillRunnableFile(file('release.py'))).toBe(true)
    expect(isSkillRunnableFile(file('tools/setup.PS1'))).toBe(true)
    expect(isSkillRunnableFile(file('bin/team-tool'))).toBe(true)
    expect(isSkillRunnableFile(file('references/guide.md', { executable: true }))).toBe(true)
  })

  it('does not label ordinary supporting files as runnable', () => {
    expect(isSkillRunnableFile(file('references/guide.md'))).toBe(false)
    expect(isSkillRunnableFile(file('assets/logo.png', { classification: 'binary' }))).toBe(false)
  })
})

describe('summarizeSkillInstallRisk', () => {
  const items = [
    { id: 'plain', name: 'plain', files: [file('SKILL.md')] },
    {
      id: 'docs',
      name: 'docs',
      files: [file('SKILL.md'), file('references/guide.md')]
    },
    {
      id: 'tools',
      name: 'tools',
      files: [
        file('SKILL.md'),
        file('release.py'),
        file('bin/tool', { classification: 'binary', executable: true })
      ]
    }
  ]

  it('separates supporting files from content that needs acknowledgement', () => {
    expect(summarizeSkillInstallRisk(items, new Set(['docs']))).toMatchObject({
      selectedSkillCount: 1,
      additionalFileCount: 1,
      runnableFileCount: 0,
      binaryFileCount: 0,
      cautionFileCount: 0,
      requiresAcknowledgement: false
    })
  })

  it('counts a runnable binary once for the acknowledgement gate', () => {
    expect(summarizeSkillInstallRisk(items, new Set(['tools']))).toEqual({
      selectedSkillCount: 1,
      additionalFileCount: 2,
      runnableFileCount: 2,
      binaryFileCount: 1,
      cautionFileCount: 2,
      cautionSkillNames: ['tools'],
      requiresAcknowledgement: true
    })
  })
})
