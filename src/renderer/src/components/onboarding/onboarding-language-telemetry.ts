import { i18n } from '@/i18n/i18n'
import { useLanguageReadiness } from '@/i18n/language-readiness'
import { getRendererLanguageDetection } from '../../../../shared/i18n/ui-locale'

export function onboardingLanguageMetadata() {
  const detection = useLanguageReadiness.getState().detection ?? getRendererLanguageDetection()
  return {
    system_language: detection.detectedTag,
    system_language_supported: detection.status === 'supported',
    detection_source: detection.source,
    effective_language: i18n.language
  }
}
