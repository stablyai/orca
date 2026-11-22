// @vitest-environment happy-dom

import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import { getDefaultSettings } from '../../../../shared/orca-profiles/constants'
import type { GlobalSettings } from '../../../../shared/settings/global-settings-types'
import {
  keepSavedPictureDescription,
  rememberGeneratedPicture,
  useSavedPictureDescription
} from './generated-avatar-descriptions'

const OWNER = { id: 'b1', hostId: 'local', avatar: 'upload:v2' }

describe('generated picture descriptions', () => {
  beforeEach(() => {
    let settings = getDefaultSettings('/home/test')
    useAppStore.setState({
      settings,
      updateSettingsOrThrow: async (updates: Partial<GlobalSettings>) => {
        settings = { ...settings, ...updates }
        useAppStore.setState({ settings })
      }
    })
  })

  it('keeps the description of a generated picture saved as the avatar', async () => {
    rememberGeneratedPicture('UE5HMQ==', 'a fox astronaut')
    keepSavedPictureDescription(OWNER, 'UE5HMQ==')
    const { result } = renderHook(() => useSavedPictureDescription(OWNER))
    await waitFor(() => expect(result.current).toBe('a fox astronaut'))
    const other = renderHook(() => useSavedPictureDescription({ ...OWNER, avatar: 'upload:v3' }))
    expect(other.result.current).toBeNull()
  })

  it('keeps nothing for an uploaded picture', () => {
    keepSavedPictureDescription(OWNER, 'VVBMT0FE')
    const { result } = renderHook(() => useSavedPictureDescription(OWNER))
    expect(result.current).toBeNull()
  })
})
