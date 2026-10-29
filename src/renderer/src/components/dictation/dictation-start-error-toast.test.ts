import { toast } from 'sonner'
import { expect, it, vi } from 'vitest'
import { showDictationStartErrorToast } from './dictation-start-error-toast'

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }))
vi.mock('@/store', () => ({ useAppStore: { getState: vi.fn() } }))

it('says dictation is in use elsewhere instead of the host error code', () => {
  showDictationStartErrorToast(
    "Error: Error invoking remote method 'speech:startDictation': Error: dictation_already_active"
  )
  expect(toast.error).toHaveBeenCalledWith(
    'Dictation is already in use on the computer or another phone.'
  )
})
