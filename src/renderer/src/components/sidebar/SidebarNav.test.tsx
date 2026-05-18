import { describe, expect, it } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { shouldShowAgentsButton } from './SidebarNav'

describe('SidebarNav', () => {
  it('hides the Agents entry while settings are loading', () => {
    expect(shouldShowAgentsButton(null)).toBe(false)
  })

  it('hides the Agents entry while the experimental Agents view is off', () => {
    expect(
      shouldShowAgentsButton({
        ...getDefaultSettings('/tmp'),
        experimentalActivity: false
      })
    ).toBe(false)
  })

  it('shows the Agents entry when the experimental Agents view is on', () => {
    expect(
      shouldShowAgentsButton({
        ...getDefaultSettings('/tmp'),
        experimentalActivity: true
      })
    ).toBe(true)
  })
})
