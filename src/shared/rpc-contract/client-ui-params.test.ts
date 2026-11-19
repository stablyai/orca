import { describe, expect, it } from 'vitest'
import { UiUpdate } from './client-ui/client-ui-params'

describe('UiUpdate activeView', () => {
  it('takes the retired Bot templates view from an older peer as the terminal', () => {
    expect(UiUpdate.parse({ activeView: 'botTemplates' })).toEqual({ activeView: 'terminal' })
  })
})
