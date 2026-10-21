import { describe, expect, it } from 'vitest'
import { summarizeSkillMarkdown } from './skill-metadata'

describe('summarizeSkillMarkdown', () => {
  it('reads name and folded description from YAML frontmatter', () => {
    const summary = summarizeSkillMarkdown(`---
name: orca-cli
description: >-
  Use the orca CLI to drive a running editor;
  keep worktree comments current.
---

# Orca CLI
`)

    expect(summary).toEqual({
      name: 'orca-cli',
      description: 'Use the orca CLI to drive a running editor; keep worktree comments current.'
    })
  })

  it('falls back to heading and first paragraph when frontmatter is absent', () => {
    const summary = summarizeSkillMarkdown(`# Design Review

Use when reviewing UI implementation quality.
`)

    expect(summary).toEqual({
      name: 'Design Review',
      description: 'Use when reviewing UI implementation quality.'
    })
  })
})

it.each(['', '\uFEFF'])('preserves the last CRLF frontmatter field with BOM %j', (bom) => {
  for (const fields of [
    ['name: actual-name', 'description: actual description'],
    ['description: actual description', 'name: actual-name']
  ]) {
    const markdown = `${bom}${['---', ...fields, '---', '# Fallback heading', '', 'Fallback paragraph'].join('\r\n')}`
    expect(summarizeSkillMarkdown(markdown)).toEqual({
      name: 'actual-name',
      description: 'actual description'
    })
  }
})
