import type { PreloadApi } from '../../../../preload/api-types'
import { TEXT_GENERATION_CLIENT_TIMEOUT_MS } from '../../../../shared/text-generation-client-timeout'
import { translate } from '@/i18n/i18n'
import { callRuntimeResult } from './web-runtime-calls'

export const discoverWebTerminalModels: PreloadApi['git']['discoverTerminalModels'] = (params) =>
  callRuntimeResult<Awaited<ReturnType<PreloadApi['git']['discoverTerminalModels']>>>(
    'agent.discoverTerminalModels',
    params,
    TEXT_GENERATION_CLIENT_TIMEOUT_MS
  ).catch(() => ({
    success: false,
    error: translate(
      'agents.terminalModels.connectionUnavailable',
      'Terminal model discovery is unavailable on this connection.'
    )
  }))
