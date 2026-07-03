import { describe, expect, it } from 'vitest'
import type { JiraCreateField } from '../../../shared/types'
import { buildJiraCreateCustomFields } from './jira-create-field-payload'

const TEXTAREA_FIELD: JiraCreateField = {
  key: 'customfield_10010',
  name: 'Steps to reproduce',
  required: true,
  schema: {
    type: 'textarea',
    custom: 'com.atlassian.jira.plugin.system.customfieldtypes:textarea'
  }
}

describe('buildJiraCreateCustomFields', () => {
  it('keeps Jira Server textarea custom fields as plain text', () => {
    expect(
      buildJiraCreateCustomFields(
        [TEXTAREA_FIELD],
        { customfield_10010: 'First line\nSecond line' },
        'server'
      )
    ).toEqual({
      customfield_10010: 'First line\nSecond line'
    })
  })

  it('keeps Jira Cloud textarea custom fields as ADF documents', () => {
    expect(
      buildJiraCreateCustomFields(
        [TEXTAREA_FIELD],
        { customfield_10010: 'First line\nSecond line' },
        'cloud'
      )
    ).toEqual({
      customfield_10010: {
        type: 'doc',
        version: 1,
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'First line' }] },
          { type: 'paragraph', content: [{ type: 'text', text: 'Second line' }] }
        ]
      }
    })
  })
})
