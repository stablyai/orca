// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SkillInstallProgress } from '../../../../shared/skill-sharing-contract'
import { useSkillInstallProgress } from './skill-install-progress-state'

afterEach(() => vi.restoreAllMocks())

describe('useSkillInstallProgress', () => {
  it('announces aggregate bundle progress and the current skill', () => {
    let listener: ((progress: SkillInstallProgress) => void) | null = null
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        skills: {
          onInstallProgress: vi.fn((next) => {
            listener = next
            return () => {
              listener = null
            }
          })
        }
      }
    })
    const hook = renderHook(() => useSkillInstallProgress())

    act(() => hook.result.current.begin('operation_1'))
    expect(hook.result.current.phaseLabel).toBe('Authorizing package access…')

    act(() =>
      listener?.({
        operationId: 'operation_1',
        phase: 'installing',
        currentSkill: { id: 'beta', name: 'beta', index: 2, total: 30 }
      })
    )
    expect(hook.result.current.phaseLabel).toBe('Installing 2 of 30: beta…')
  })
})
