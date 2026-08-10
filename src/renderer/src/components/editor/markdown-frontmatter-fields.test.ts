import { describe, expect, it } from 'vitest'
import { parseFrontMatterFields } from './markdown-frontmatter-fields'

describe('parseFrontMatterFields', () => {
  it('parses scalar YAML fields into key/value rows', () => {
    const raw = '---\ntitle: Hello\ndraft: true\n---\n'
    expect(parseFrontMatterFields(raw)).toEqual([
      { key: 'title', value: 'Hello' },
      { key: 'draft', value: 'true' }
    ])
  })

  it('comma-joins array values', () => {
    const raw = '---\ntags: [a, b, c]\n---\n'
    expect(parseFrontMatterFields(raw)).toEqual([{ key: 'tags', value: 'a, b, c' }])
  })

  it('renders nested maps as readable key: value pairs', () => {
    const raw = '---\nauthor:\n  name: Ada\n  id: 7\n---\n'
    expect(parseFrontMatterFields(raw)).toEqual([{ key: 'author', value: 'name: Ada, id: 7' }])
  })

  it('renders nested maps under a top-level key inline', () => {
    const raw = '---\nmetadata:\n  type: demo\n  version: 2\n---\n'
    expect(parseFrontMatterFields(raw)).toEqual([
      { key: 'metadata', value: 'type: demo, version: 2' }
    ])
  })

  it('renders YAML timestamp values as their string form', () => {
    const raw = '---\ndate: 2021-06-15\nstamp: 2021-06-15T10:30:00Z\n---\n'
    expect(parseFrontMatterFields(raw)).toEqual([
      { key: 'date', value: '2021-06-15' },
      { key: 'stamp', value: '2021-06-15T10:30:00Z' }
    ])
  })

  it('returns null for TOML front matter', () => {
    expect(parseFrontMatterFields('+++\ntitle = "Hi"\n+++\n')).toBeNull()
  })

  it('returns null for a bare scalar or list', () => {
    expect(parseFrontMatterFields('---\njust a string\n---\n')).toBeNull()
    expect(parseFrontMatterFields('---\n- a\n- b\n---\n')).toBeNull()
  })

  it('returns null for an empty map', () => {
    expect(parseFrontMatterFields('---\n---\n')).toBeNull()
  })

  it('returns null on invalid YAML', () => {
    expect(parseFrontMatterFields('---\nkey: : :\n  bad\n---\n')).toBeNull()
  })
})
