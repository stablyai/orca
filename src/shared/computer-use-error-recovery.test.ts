import { describe, expect, it } from 'vitest'
import { computerUseErrorRecoveryData } from './computer-use-error-recovery'
import { COMPUTER_ERROR_CODES } from './runtime-types'

describe('computerUseErrorRecoveryData', () => {
  it('covers every declared computer-use error code with actionable recovery steps', () => {
    for (const code of Object.values(COMPUTER_ERROR_CODES)) {
      expect(computerUseErrorRecoveryData(code), code).toMatchObject({
        nextSteps: expect.arrayContaining([expect.any(String)])
      })
    }
  })

  it('points screenshot failures at permission setup or no-screenshot fallback', () => {
    const recovery = computerUseErrorRecoveryData('screenshot_failed')

    expect(recovery?.nextSteps).toEqual([
      expect.stringContaining('--no-screenshot'),
      expect.stringContaining('--id screenshots'),
      expect.stringContaining('payload cap')
    ])
  })

  it('points permission failures at targeted permission setup when possible', () => {
    const recovery = computerUseErrorRecoveryData('permission_denied')

    expect(recovery?.nextSteps).toEqual([
      expect.stringContaining('--id accessibility'),
      expect.stringContaining('graphical desktop session')
    ])
  })

  it('points missing windows at list-windows before a single restore retry', () => {
    const recovery = computerUseErrorRecoveryData('window_not_found')

    expect(recovery?.nextSteps).toEqual([
      expect.stringContaining('list-windows'),
      expect.stringContaining('--restore-window'),
      expect.stringContaining('does not launch closed desktop apps')
    ])
  })

  it('keeps missing web app recovery within computer-use desktop app targeting', () => {
    const recovery = computerUseErrorRecoveryData('app_not_found')

    expect(recovery?.nextSteps).toEqual([
      expect.stringContaining('list-apps'),
      expect.stringContaining('desktop browser app/window'),
      expect.stringContaining('--app <web app>'),
      expect.stringContaining('list-windows --app <browser>')
    ])
    expect(recovery?.nextSteps.join('\n')).not.toContain('orca goto')
  })
})
